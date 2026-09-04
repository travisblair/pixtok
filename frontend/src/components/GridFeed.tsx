import {
  createEffect,
  createSignal,
  For,
  Show,
  onCleanup,
} from "solid-js";
import type { PixivIllust } from "../types";
import { getLikeState } from "../store";
import { api } from "../api";
import UgoiraPlayer from "./UgoiraPlayer";

const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
// Load/unload window for grid cells: 3 viewports. Cells scrolled beyond
// it swap their src to the 1px placeholder, freeing the decode; coming
// back re-fetches from cache. square_medium thumbs are small (~50-100KB)
// but hundreds of accumulated decodes after a long scroll is exactly
// the footprint that gets the iOS tab purged — bounded beats churn.
const GRID_MARGIN = "300% 0px 300% 0px";

/**
 * Grid renderer for feed tabs + artist pages (the view-mode toggle).
 *
 * Cells are deliberately minimal (settled spec): image + heart + ugoira
 * badge. No title/artist/tags — the strip carries the text overlays.
 *
 * Cells carry the same scroll-based image window as the strip: within
 * 3 viewports → image loaded; scrolled past → unloaded to a 1px
 * placeholder (500ms exit hysteresis so boundary wiggle doesn't churn).
 * Covered layers unload entirely via suppressImages. Ugoira teardown on
 * scroll-away stays in UgoiraPlayer's own observer (zips are MBs).
 */
export default function GridFeed(props: {
  illusts: PixivIllust[];
  onLike?: (illust: PixivIllust) => void;
  onUnlike?: (illust: PixivIllust) => void;
  onTap?: (illust: PixivIllust) => void;
  // True when this grid's layer is covered by another full-screen layer
  // (artist page under a stack). Unlike the scroll window, covered-layer
  // suppression DOES apply to cells: stacked layers keep ugoira players
  // and decodes alive otherwise.
  suppressImages?: boolean;
}) {
  return (
    <div class="feed-grid">
      <For each={props.illusts}>
        {(illust) => (
          <GridCell
            illust={illust}
            onLike={props.onLike}
            onUnlike={props.onUnlike}
            onTap={props.onTap}
            suppressImages={props.suppressImages}
          />
        )}
      </For>
    </div>
  );
}

function GridCell(props: {
  illust: PixivIllust;
  onLike?: (illust: PixivIllust) => void;
  onUnlike?: (illust: PixivIllust) => void;
  onTap?: (illust: PixivIllust) => void;
  suppressImages?: boolean;
}) {
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [attempts, setAttempts] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  // Ugoira play/pause: the badge below bumps this counter; the player
  // reports status back for the icon/label (same wiring as the strip).
  const [ugoiraToggle, bumpUgoiraToggle] = createSignal(0);
  const [ugoiraStatus, setUgoiraStatus] = createSignal<
    "idle" | "loading" | "playing" | "paused"
  >("idle");
  // SHARED bookmark state (store.ts) — the same illust can be mounted
  // as a grid cell AND a strip card; hearts must always agree.
  const like = getLikeState(props.illust.id, props.illust.is_bookmarked);
  const liked = like.liked;
  const setLiked = like.setLiked;
  // Scroll-based image window: offscreen cells hold no decode (see the
  // GRID_MARGIN docs above). Defaults inactive — the IO flips it on.
  const [active, setActive] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  let unloadTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    if (props.suppressImages) {
      setActive(false);
      setLoaded(false);
      setError(false);
      return;
    }
    const root = rootRef?.closest<HTMLElement>(".feed-container") ?? null;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          clearTimeout(unloadTimer);
          setActive(true);
        } else {
          // Hysteresis: only unload after 500ms out of range so boundary
          // wiggle doesn't re-fetch/re-decode in a churn loop.
          clearTimeout(unloadTimer);
          unloadTimer = setTimeout(() => setActive(false), 500);
        }
      },
      { root, rootMargin: GRID_MARGIN }
    );
    if (rootRef) io.observe(rootRef);
    onCleanup(() => {
      io.disconnect();
      clearTimeout(unloadTimer);
    });
  });

  // Deactivation resets per-cell state so re-activation loads fresh and
  // no stale spinners/retries render offscreen.
  createEffect(() => {
    if (!active()) {
      setLoaded(false);
      setError(false);
    }
  });

  // square_medium is the grid's native size. Feeds that don't carry it
  // fall back to medium → large (same chain as the data-saver pick).
  const img =
    props.illust.image_urls.square_medium ||
    props.illust.image_urls.medium ||
    props.illust.image_urls.large;

  const src = () =>
    props.suppressImages || !active()
      ? PIXEL
      : `/api/img?url=${encodeURIComponent(img)}${
          attempts() > 0 ? `&r=${attempts()}` : ""
        }`;

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
        props.onUnlike?.(props.illust); // bookmarks tab removes the cell
      }
    } catch {
      setLiked(!newLiked); // revert on failure
    } finally {
      setBusy(false);
    }
  }

  function retry(e: Event) {
    e.stopPropagation();
    setError(false);
    setAttempts((a) => a + 1); // &r=N forces a fresh fetch past the failed request
  }

  function handleTap(e: MouseEvent) {
    if (!props.onTap) return;
    const target = e.target as HTMLElement;
    // Ignore taps on the cell's interactive children — heart, ugoira
    // badge, retry — so controls never open a stack.
    if (target.closest(".grid-cell-heart, .grid-cell-ugoira, .grid-cell-retry")) return;
    props.onTap(props.illust);
  }

  return (
    <div class="grid-cell" onClick={handleTap} ref={rootRef}>
      <Show
        when={props.illust.type === "ugoira" && !props.suppressImages}
        fallback={
          <>
            <Show when={!loaded() && !error()}>
              <div class="grid-cell-placeholder">
                <div class="spinner" />
              </div>
            </Show>
            <Show when={error()}>
              <button
                type="button"
                class="grid-cell-retry overlay-pill"
                onClick={retry}
                aria-label="Retry image"
              >
                ↻
              </button>
            </Show>
            <img
              src={src()}
              alt={props.illust.title}
              loading="lazy"
              class={loaded() ? "grid-cell-image loaded" : "grid-cell-image"}
              onLoad={() => setLoaded(true)}
              onError={() => setError(true)}
            />
          </>
        }
      >
        <UgoiraPlayer
          illustId={props.illust.id}
          staticUrl={props.illust.image_urls.large}
          title={props.illust.title}
          toggleSignal={ugoiraToggle()}
          onStatus={setUgoiraStatus}
          maxFrameSide={360}
          maxPosterSide={720}
        />
        <button
          type="button"
          class="grid-cell-ugoira overlay-pill"
          onClick={(e) => {
            e.stopPropagation();
            bumpUgoiraToggle((t) => t + 1);
          }}
          aria-label={
            ugoiraStatus() === "playing"
              ? "Pause animation"
              : "Play animation"
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
      <button
        type="button"
        class="grid-cell-heart"
        onClick={toggleLike}
        aria-label={liked() ? "Remove bookmark" : "Bookmark"}
      >
        {liked() ? "❤️" : "🤍"}
      </button>
    </div>
  );
}
