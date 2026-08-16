import { createSignal, createEffect, For, Show } from "solid-js";
import { api } from "../api";
import type { PixivIllust } from "../types";
import FeedCard from "./FeedCard";
import GridFeed from "./GridFeed";
import { dedupeSeen, filterBlockedTags } from "../helpers";
import { blockedTags, artistViewMode } from "../store";
import { useFeedSentinel } from "../hooks";

/**
 * Full-screen feed of one artist's works (app API /v1/user/illusts,
 * paginated). Opened by tapping the artist name on any card. Tapping a
 * work pushes a RelatedView on top; tapping another artist name swaps
 * this view to that artist.
 */
export default function ArtistView(props: {
  userId: number;
  userName: string;
  zIndex: number;
  closing?: boolean; // true while the slide-out animation plays
  obscured?: boolean; // covered by a stack — unload this layer's images
  onClose: () => void;
  onTap: (illust: PixivIllust) => void;
  onArtistTap: (illust: PixivIllust) => void;
  onTagsTap: (illust: PixivIllust) => void;
  onTagOpen?: (tag: string) => void;
}) {
  const [illusts, setIllusts] = createSignal<PixivIllust[]>([]);
  const [nextUrl, setNextUrl] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [loadMoreError, setLoadMoreError] = createSignal(false);
  let sentinelRef: HTMLDivElement | undefined;
  let reqSeq = 0;
  const seen = new Set<number>();

  // Artist swap: tapping another artist's name inside this view changes
  // props.userId WITHOUT remounting (App keeps one ArtistView instance
  // under <Show>). Reset every piece of component-local state and
  // reload for the new artist — otherwise the previous artist's works
  // stay on screen under the new name.
  let lastUserId: number | undefined;
  createEffect(() => {
    const uid = props.userId;
    if (lastUserId !== undefined && lastUserId !== uid) {
      reqSeq++; // invalidate any in-flight load
      seen.clear();
      setIllusts([]);
      setNextUrl(null);
      setLoading(false);
      setError(false);
      setLoadMoreError(false);
      void loadMore();
    }
    lastUserId = uid;
  });

  async function loadMore() {
    if (loading()) return;
    const seq = ++reqSeq;
    setLoading(true);
    setLoadMoreError(false);
    try {
      const data = nextUrl()
        ? await api.getNextPage(nextUrl()!)
        : await api.getUserIllusts(props.userId);
      if (seq !== reqSeq) return;
      const fresh = dedupeSeen(
        seen,
        filterBlockedTags(data.illusts, blockedTags())
      );
      setIllusts((prev) => [...prev, ...fresh]);
      setNextUrl(data.next_url);
      setError(false);
    } catch (err) {
      if (seq === reqSeq) {
        console.error("Failed to load artist works:", err);
        setLoadMoreError(true);
        if (illusts().length === 0) setError(true);
      }
    } finally {
      if (seq === reqSeq) setLoading(false);
    }
  }

  useFeedSentinel(
    () => sentinelRef,
    () => !!nextUrl() && !loading(),
    () => void loadMore()
  );

  void loadMore();

  return (
    <div
      class={props.closing ? "artist-view exit" : "artist-view enter"}
      style={{ "z-index": props.zIndex }}
    >
      <div
        class={
          artistViewMode() === "grid"
            ? "feed-container grid-container"
            : "feed-container"
        }
      >
        <Show
          when={artistViewMode() === "strip"}
          fallback={
            <GridFeed
              illusts={illusts()}
              onTap={props.onTap}
              suppressImages={props.obscured || props.closing}
            />
          }
        >
          <For each={illusts()}>
            {(illust) => (
              <FeedCard
                illust={illust}
                onTap={props.onTap}
                onArtistTap={props.onArtistTap}
                onTagsTap={props.onTagsTap}
                onTagOpen={props.onTagOpen}
                suppressImages={props.obscured || props.closing}
              />
            )}
          </For>
        </Show>
        <div ref={sentinelRef} class="feed-sentinel">
          {loading() && <div class="spinner" />}
          {error() && !loading() && <span>Couldn't load this artist's works</span>}
          {loadMoreError() && !loading() && (
            <button type="button" class="mode-pill" onClick={() => void loadMore()}>
              Couldn't load — tap to retry
            </button>
          )}
        </div>
      </div>

      <div class="related-header-left">
        <button type="button" class="related-back overlay-pill" onClick={props.onClose} aria-label="Back">
          ← Back
        </button>
      </div>
      <div class="artist-name-badge overlay-pill" aria-live="polite">
        {props.userName}
      </div>
    </div>
  );
}
