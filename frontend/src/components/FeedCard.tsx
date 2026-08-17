import {
  createSignal,
  createEffect,
  For,
  Show,
  onCleanup,
} from "solid-js";
import type { PixivIllust } from "../types";
import { api } from "../api";
import {
  sliderWindowBounds,
  computeLoadDelay,
  sliderWindowSize,
  normalizeTagPairs,
} from "../helpers";
import { getLikeState, imageSize } from "../store";
import UgoiraPlayer from "./UgoiraPlayer";
import FollowButton from "./FollowButton";

const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const CARD_MARGIN = "600% 0px 600% 0px"; // load/unload threshold: 6 viewports

export default function FeedCard(props: {
  illust: PixivIllust;
  onLike?: (illust: PixivIllust) => void;
  onUnlike?: (illust: PixivIllust) => void;
  onTap?: (illust: PixivIllust) => void;
  onArtistTap?: (illust: PixivIllust) => void;
  onTagsTap?: (illust: PixivIllust) => void;
  // Tag row: tap a chip to open that tag's page.
  onTagOpen?: (tag: string) => void;
  // True when the card's layer is covered by another full-screen layer.
  // IO reports GEOMETRIC intersection, not visual occlusion, so covered
  // layers would otherwise keep full image windows alive — N stacked
  // layers × decoded master1200s jetsams iOS and hard-reloads the page.
  suppressImages?: boolean;
}) {
  const [loaded, setLoaded] = createSignal<Set<number>>(new Set());
  const [error, setError] = createSignal<Set<number>>(new Set());
  const [attempts, setAttempts] = createSignal<Record<number, number>>({});
  const [currentPage, setCurrentPage] = createSignal(0);
  // Settled page (drives the load window) vs live page (drives the
  // counter). iOS momentum + scroll-snap: the last scroll event can
  // fire MID-snap with a rounded index that doesn't match the resting
  // page, and no further event fires once the snap lands. The settle
  // detector polls scrollLeft until it's still, then commits the true
  // page; the load window follows the settled page.
  const [settledPage, setSettledPage] = createSignal(0);
  // SHARED bookmark state (store.ts) — the same illust is mounted in the
  // main feed AND as a stack anchor AND possibly in the recs modal; all
  // instances must reflect the same heart.
  const like = getLikeState(props.illust.id, props.illust.is_bookmarked);
  const liked = like.liked;
  const setLiked = like.setLiked;
  const [active, setActive] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // Ugoira play/pause control lives in the overlay (small, above the
  // title, always visible). The counter is the toggle signal handed to
  // the player; the player reports status back for the icon/label.
  const [ugoiraToggle, bumpUgoiraToggle] = createSignal(0);
  const [ugoiraStatus, setUgoiraStatus] = createSignal<
    "idle" | "loading" | "playing" | "paused"
  >("idle");
  let pagesRef: HTMLDivElement | undefined;
  let rootRef: HTMLDivElement | undefined;
  let unloadTimer: ReturnType<typeof setTimeout> | undefined;
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let settleRead: number | undefined;

  const pages = props.illust.meta_pages?.length
    ? props.illust.meta_pages
    : [{ image_urls: props.illust.image_urls }];

  const hasMultiple = pages.length > 1;
  const artistName = props.illust.user.name || props.illust.user.account;

  const tags = () => props.illust.tags ?? [];

  // ── Tag row layout ────────────────────────────────────────────────────
  // Spec: fill row 1 fully (stopping before the gear), then row 2; if the
  // tags need MORE than two natural rows, the 2-row strip scrolls
  // horizontally — overflow rows interleave onto the two lines
  // (rows 1,3,5→top; 2,4,6→bottom) so reading order stays row-major.
  // Measurement: render the natural wrap once, bucket chips into rows by
  // offsetTop, then re-pack if there are more than 2 rows.
  type TagPair = { name: string; translated?: string };
  const [tagLines, setTagLines] = createSignal<{
    top: TagPair[];
    bottom: TagPair[];
  } | null>(null);
  let tagRowRef: HTMLDivElement | undefined;

  function measureTagRow() {
    const el = tagRowRef;
    if (!el) return;
    const chips = Array.from(
      el.querySelectorAll<HTMLElement>(".card-tag-chip")
    );
    if (chips.length === 0) {
      setTagLines(null);
      return;
    }
    let prevTop: number | null = null;
    const rows: number[][] = [];
    let cur: number[] = [];
    for (let i = 0; i < chips.length; i++) {
      const t = chips[i].offsetTop;
      if (prevTop === null || t === prevTop) {
        cur.push(i);
      } else {
        rows.push(cur);
        cur = [i];
      }
      prevTop = t;
    }
    rows.push(cur);
    if (rows.length <= 2) {
      setTagLines(null); // natural wrap already correct
      return;
    }
    const pairs = normalizeTagPairs(props.illust);
    const top: TagPair[] = [];
    const bottom: TagPair[] = [];
    rows.forEach((row, ri) => {
      const target = ri % 2 === 0 ? top : bottom;
      for (const i of row) target.push(pairs[i]);
    });
    setTagLines({ top, bottom });
  }

  // Re-measure whenever the row mounts/updates (Solid effects run after
  // the DOM commit, so the ref and chips exist).
  createEffect(() => {
    void tags();
    if (tagRowRef) measureTagRow();
  });

  function renderChip(tag: TagPair) {
    return (
      <button
        type="button"
        class="card-tag-chip"
        onClick={(e) => {
          e.stopPropagation();
          props.onTagOpen?.(tag.name);
        }}
      >
        <span class="card-tag-name">#{tag.name}</span>
        <Show when={tag.translated}>
          <span class="card-tag-translation">{tag.translated}</span>
        </Show>
      </button>
    );
  }

  // Big sliders (long manga) keep a tight ±1 window so decoded bitmaps
  // stay bounded on iOS — see sliderWindowSize in helpers.ts.
  const windowSize = sliderWindowSize(pages.length);

  // Card-level IntersectionObserver: within 6 viewports → load images.
  // Scrolled past → unload (srcs swap to a 1px placeholder, freeing bitmaps).
  // NOTE: must pass the scroll container as `root` — Chromium clamps
  // rootMargin to ~1 viewport when using the implicit viewport root.
  // NOTE 2: gated on suppressImages — covered layers unload entirely so
  // stacked overlays can't accumulate N full image windows.
  createEffect(() => {
    if (props.suppressImages) {
      setActive(false);
      setLoaded(new Set<number>());
      setError(new Set<number>());
      return;
    }
    const root = rootRef?.closest<HTMLElement>(".feed-container") ?? null;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        // Distance-prioritized activation: visible/nearby cards load at
        // once; cards deeper in the 6-viewport window wait proportionally
        // (up to ~600ms). Prevents a fresh-content burst (e.g. ~90 recs
        // after a like) from making ~13 cards' images compete for
        // bandwidth and decode right as the user scrolls into them.
        clearTimeout(unloadTimer);
        if (!active()) {
          clearTimeout(loadTimer);
          const r = entry.boundingClientRect;
          const rb = entry.rootBounds;
          const vh = rb?.height || window.innerHeight;
          const dist = rb
            ? Math.max(rb.top - r.bottom, r.top - rb.bottom, 0)
            : 0;
          const delay = computeLoadDelay({ distPx: dist, viewportPx: vh });
          loadTimer = setTimeout(() => setActive(true), delay);
        }
      } else {
        // Hysteresis: only unload after 500ms out of range. Without this,
        // wiggling around the 6-viewport boundary re-fetches/re-decodes
        // images in a churn loop while scrolling up and down.
        clearTimeout(loadTimer);
        clearTimeout(unloadTimer);
        unloadTimer = setTimeout(() => setActive(false), 500);
      }
    }, { root, rootMargin: CARD_MARGIN });
    if (rootRef) io.observe(rootRef);
    onCleanup(() => {
      io.disconnect();
      clearTimeout(unloadTimer);
      clearTimeout(loadTimer);
    });
    onCleanup(() => clearTimeout(settleTimer));
  });

  // When the card deactivates, reset per-page state so re-activation
  // reloads fresh and no spinners render off-screen.
  createEffect(() => {
    if (!active()) {
      setLoaded(new Set<number>());
      setError(new Set<number>());
      setAttempts({});
    }
  });

  function shouldLoad(i: number) {
    const [lo, hi] = sliderWindowBounds(
      currentPage(),
      settledPage(),
      windowSize
    );
    return active() && i >= lo && i <= hi;
  }

  // Prune load/error state for pages that leave the load window. Without
  // this, a long slider accumulates every visited page in `loaded` and
  // re-returning pages flash a stale "loaded" frame with no bitmap (their
  // srcs were swapped to the 1px placeholder on the way out).
  createEffect(() => {
    void currentPage();
    void settledPage();
    void active();
    const keep = (i: number) => shouldLoad(i);
    setLoaded((prev) => {
      const next = new Set([...prev].filter(keep));
      return next.size === prev.size ? prev : next;
    });
    setError((prev) => {
      const next = new Set([...prev].filter(keep));
      return next.size === prev.size ? prev : next;
    });
  });

  async function toggleLike(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (busy()) return; // in-flight lock: no double-tap POST races
    setBusy(true);
    const newLiked = !liked();
    setLiked(newLiked);
    try {
      if (newLiked) {
        await api.like(props.illust.id);
        props.onLike?.(props.illust);
      } else {
        await api.unlike(props.illust.id);
        props.onUnlike?.(props.illust); // bookmarks tab removes the card
      }
    } catch {
      setLiked(!newLiked); // revert on failure
    } finally {
      setBusy(false);
    }
  }

  function onPageLoad(index: number) {
    // Ignore placeholder pixel loads AND loads completing after the page
    // left the preload window (src swapped to PIXEL mid-flight).
    if (!active() || !shouldLoad(index)) return;
    setLoaded(prev => new Set([...prev, index]));
  }

  function onPageError(index: number) {
    if (!active()) return;
    setError(prev => new Set([...prev, index]));
  }

  function retryPage(index: number) {
    // Clear the error (spinner placeholder returns) and bump the attempt
    // counter — the img src gains `&r=N`, forcing a fresh fetch past the
    // browser's failed-request state.
    setError(prev => new Set([...prev].filter((i) => i !== index)));
    setAttempts(prev => ({ ...prev, [index]: (prev[index] ?? 0) + 1 }));
  }

  function onScroll() {
    if (!pagesRef) return;
    const idx = Math.round(pagesRef.scrollLeft / pagesRef.clientWidth);
    setCurrentPage(idx);
    // Re-arm the settle detector. While the snap/momentum animation is
    // still moving scrollLeft, keep polling; when two reads agree, the
    // slider is at rest and THAT page owns the load window.
    clearTimeout(settleTimer);
    settleRead = undefined;
    settleTimer = setTimeout(checkSettle, 120);
  }

  function checkSettle() {
    if (!pagesRef) return;
    const left = pagesRef.scrollLeft;
    const idx = Math.round(left / pagesRef.clientWidth);
    if (settleRead !== undefined && Math.abs(left - settleRead) < 2) {
      // At rest (or the snap finished): commit the true resting page.
      setSettledPage(idx);
      setCurrentPage(idx); // the counter catches up to reality
      settleRead = undefined;
      return;
    }
    settleRead = left;
    settleTimer = setTimeout(checkSettle, 120);
  }

  function renderPage(page: (typeof pages)[0], i: number) {
    // Ugoira works are animated — hand the visible page to the canvas
    // player (which loads frames only while actually on screen). Covered
    // layers get the static frame instead (players are heavy).
    if (props.illust.type === "ugoira" && i === 0 && !props.suppressImages) {
      return (
        <div class="card-page">
          <UgoiraPlayer
            illustId={props.illust.id}
            staticUrl={page.image_urls.large}
            title={props.illust.title}
            toggleSignal={ugoiraToggle()}
            onStatus={setUgoiraStatus}
          />
        </div>
      );
    }
    const attempt = attempts()[i] ?? 0;
    // Data saver mode prefers the 540px variant when the feed carries it
    // (street + app-API feeds do); web square-thumbs fall back to large.
    const sizeUrl =
      imageSize() === "medium"
        ? page.image_urls.medium || page.image_urls.large
        : page.image_urls.large;
    const imgUrl = `/api/img?url=${encodeURIComponent(sizeUrl)}${attempt > 0 ? `&r=${attempt}` : ""}`;
    return (
      <div class="card-page">
        <Show when={shouldLoad(i) && !loaded().has(i) && !error().has(i)}>
          <div class="card-placeholder">
            <div class="spinner" />
          </div>
        </Show>
        <Show when={shouldLoad(i) && error().has(i)}>
          <div class="card-placeholder">
            <button
              type="button"
              class="page-retry overlay-pill"
              onClick={(e) => {
                e.stopPropagation();
                retryPage(i);
              }}
            >
              ↻ Try again
            </button>
          </div>
        </Show>
        <img
          src={shouldLoad(i) ? imgUrl : PIXEL}
          alt={`${props.illust.title} — page ${i + 1}`}
          class={loaded().has(i) ? "card-image loaded" : "card-image"}
          onLoad={() => onPageLoad(i)}
          onError={() => onPageError(i)}
        />
      </div>
    );
  }

  function handleTap(e: MouseEvent) {
    if (!props.onTap) return;
    const t = e.target as HTMLElement;
    // ignore taps on interactive children (like button, tags button,
    // artist link, page counter, tag chips); slider swipes don't fire
    // click so no conflict there
    if (t.closest(".like-btn, .tags-btn, a, .page-counter, .card-tag-row")) return;
    props.onTap(props.illust);
  }

  return (
    <div
      class="feed-card"
      ref={rootRef}
      onClick={handleTap}
    >
      <Show
        when={hasMultiple}
        fallback={renderPage(pages[0], 0)}
      >
        {/* Multi-page slider */}
        <div class="card-pages" ref={pagesRef} onScroll={onScroll}>
          <For each={pages}>
            {(page, i) => renderPage(page, i())}
          </For>
        </div>
        <div class="page-counter">
          {currentPage() + 1}/{pages.length}
        </div>
      </Show>

      {/* Right-edge action stack — one flex column so the gear sits an
          EXACT 16px below the heart on every device (font metrics make
          two independently-absolute buttons drift apart). */}
      <div class="card-right-stack">
        <button
          type="button"
          class="like-btn"
          onClick={toggleLike}
          aria-label={liked() ? "Remove bookmark" : "Bookmark"}
        >
          {liked() ? "❤️" : "🤍"}
        </button>

        {/* Tag blocking button — opens the block/unblock popup for this
            work. Gear icon: the tag chips on the card are for OPENING tag
            pages, this one is for FILTERING. */}
        <button
          type="button"
          class="tags-btn"
          onClick={(e) => {
            e.stopPropagation();
            props.onTagsTap?.(props.illust);
          }}
          aria-label="Block this work's tags"
        >
          ⚙️
        </button>
      </div>

      <div class="card-overlay">
        {/* Ugoira play/pause: small, above the title, always visible. */}
        <Show when={props.illust.type === "ugoira" && !props.suppressImages}>
          <button
            type="button"
            class="card-ugoira-control"
            onClick={(e) => {
              e.stopPropagation();
              bumpUgoiraToggle((t) => t + 1);
            }}
            aria-label={
              ugoiraStatus() === "playing" ? "Pause animation" : "Play animation"
            }
          >
            {ugoiraStatus() === "playing" ? (
              <span class="ugoira-pause-bars" aria-hidden="true">
                <span />
                <span />
              </span>
            ) : (
              "▶"
            )}
          </button>
        </Show>
        <h2 class="card-title">{props.illust.title}</h2>
        <p class="card-artist">
          by{" "}
          <a
            href={`https://pixiv.net/users/${props.illust.user.id}`}
            onClick={(e) => {
              // Open the artist's library in-app instead of leaving.
              e.preventDefault();
              e.stopPropagation();
              props.onArtistTap?.(props.illust);
            }}
          >
            {artistName}
          </a>
          <FollowButton
            userId={props.illust.user.id}
            label={artistName}
            small
          />
        </p>
        {/* Tag chips: natural row-major wrap (fill row 1 fully, stopping
            before the gear, then row 2). When tags need more than two
            rows the strip switches to two interleaved lines that scroll
            horizontally. Chips carry the Pixiv translation under the
            name when one exists. */}
        <Show when={tags().length > 0}>
          <Show
            when={tagLines() === null}
            fallback={
              <div class="card-tag-scroller no-scrollbar fade-edges">
                <div class="card-tag-line">
                  <For each={tagLines()!.top}>{(tag) => renderChip(tag)}</For>
                </div>
                <div class="card-tag-line">
                  <For each={tagLines()!.bottom}>{(tag) => renderChip(tag)}</For>
                </div>
              </div>
            }
          >
            <div class="card-tag-row no-scrollbar fade-edges" ref={tagRowRef}>
              <For each={normalizeTagPairs(props.illust)}>
                {(tag) => renderChip(tag)}
              </For>
            </div>
          </Show>
        </Show>
        {/* Web feeds carry 0/0 stats — hide the row entirely then */}
        <Show when={props.illust.total_bookmarks > 0 || props.illust.total_view > 0}>
          <div class="card-stats">
            <span>♥ {props.illust.total_bookmarks.toLocaleString()}</span>
            <span>👁 {props.illust.total_view.toLocaleString()}</span>
          </div>
        </Show>
      </div>
    </div>
  );
}
