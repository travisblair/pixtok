import { createSignal, For, Show } from "solid-js";
import type { PixivIllust } from "../types";
import { getLikeState } from "../store";
import { api } from "../api";
import UgoiraPlayer from "./UgoiraPlayer";

const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/**
 * Grid renderer for feed tabs + artist pages (the view-mode toggle).
 *
 * Cells are deliberately minimal (settled spec): image + heart + ugoira
 * badge. No title/artist/tags — the strip carries the text overlays.
 *
 * Unlike the strip FeedCard, grid cells are EXEMPT from the scroll-based
 * image unload window: square_medium thumbs are ~50-100KB each and a
 * grid consumes them much faster than the strip — unload churn would
 * cost more than it saves. Offscreen fetches are deferred by native
 * lazy loading instead. Ugoira teardown on scroll-away still applies
 * (UgoiraPlayer's own IntersectionObserver) because zips are MBs.
 */
export default function GridFeed(props: {
  illusts: PixivIllust[];
  onLike?: (illust: PixivIllust) => void;
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

  // square_medium is the grid's native size. Feeds that don't carry it
  // fall back to medium → large (same chain as the data-saver pick).
  const img =
    props.illust.image_urls.square_medium ||
    props.illust.image_urls.medium ||
    props.illust.image_urls.large;

  const src = () =>
    props.suppressImages
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
    const t = e.target as HTMLElement;
    // Ignore taps on the cell's interactive children — heart, ugoira
    // badge, retry — so controls never open a stack.
    if (t.closest(".grid-cell-heart, .grid-cell-ugoira, .grid-cell-retry")) return;
    props.onTap(props.illust);
  }

  return (
    <div class="grid-cell" onClick={handleTap}>
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
