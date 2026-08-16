import { createSignal, For, Show } from "solid-js";
import { api } from "../api";
import type { PixivIllust } from "../types";
import FeedCard from "./FeedCard";
import { filterBlockedTags, dedupeSeen } from "../helpers";
import { blockedTags, stackHintDismissed, dismissStackHint } from "../store";
import { useFeedSentinel } from "../hooks";

export default function RelatedView(props: {
  anchor: PixivIllust;
  zIndex: number;
  depth: number; // 1-based position in the stack
  maxDepth: number;
  closing?: boolean; // true while the slide-out animation plays
  obscured?: boolean; // covered by another layer — unload this layer's images
  onClose: () => void;
  onCloseAll: () => void;
  onPush: (illust: PixivIllust) => void;
  onArtistTap: (illust: PixivIllust) => void;
  onTagsTap: (illust: PixivIllust) => void;
  onTagOpen?: (tag: string) => void;
}) {
  const [illusts, setIllusts] = createSignal<PixivIllust[]>([props.anchor]);
  const [nextUrl, setNextUrl] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [loadMoreError, setLoadMoreError] = createSignal(false);
  let sentinelRef: HTMLDivElement | undefined;
  // Pixiv similarity pages re-inject works across pages like the
  // personalized feeds — dedupe by id on append.
  const seen = new Set<number>([props.anchor.id]);

  async function loadRelated() {
    try {
      const data = await api.getRelated(props.anchor.id);
      const fresh = dedupeSeen(
        seen,
        filterBlockedTags(
          data.illusts.filter((i) => i.id !== props.anchor.id),
          blockedTags()
        )
      );
      setIllusts(prev => [...prev, ...fresh]);
      setNextUrl(data.next_url);
    } catch (err) {
      console.error("Failed to load related:", err);
      setError(true);
    }
  }

  async function loadMore() {
    if (loading()) return;
    setLoading(true);
    setLoadMoreError(false);
    try {
      const data = await api.getNextPage(nextUrl()!);
      setIllusts(prev => [
        ...prev,
        ...dedupeSeen(seen, filterBlockedTags(data.illusts, blockedTags())),
      ]);
      setNextUrl(data.next_url);
    } catch (err) {
      console.error("Failed to load more related:", err);
      // The observer won't re-fire on its own — surface a retry.
      setLoadMoreError(true);
    } finally {
      setLoading(false);
    }
  }

  useFeedSentinel(
    () => sentinelRef,
    // Errors gate pagination: a failed page must stop auto-firing (the
    // re-subscribe storm in App.tsx applies here too) and wait for the
    // retry button.
    () => !!nextUrl() && !loading() && !loadMoreError() && !error(),
    () => void loadMore(),
    "200px"
  );

  // Fetch related works once on mount (anchor is already rendered at top).
  void loadRelated();

  return (
    <div
      class={props.closing ? "related-view exit" : "related-view enter"}
      style={{ "z-index": props.zIndex }}
    >
      <div class="feed-container">
        <For each={illusts()}>
          {(illust) => (
            <FeedCard
              illust={illust}
              onTap={props.onPush}
              onArtistTap={props.onArtistTap}
              onTagsTap={props.onTagsTap}
              onTagOpen={props.onTagOpen}
              suppressImages={props.obscured || props.closing}
            />
          )}
        </For>

        <div ref={sentinelRef} class="feed-sentinel">
          {loading() && <div class="spinner" />}
          {error() && !loading() && <span>Couldn't load related works</span>}
          {loadMoreError() && !loading() && (
            <button type="button" class="mode-pill" onClick={() => void loadMore()}>
              Couldn't load — tap to retry
            </button>
          )}
        </div>
      </div>

      <div class="related-header-left">
        <button type="button" class="related-back overlay-pill" onClick={props.onClose}>
          ← Back
        </button>
        <button
          type="button"
          class="close-all-btn overlay-pill"
          onClick={props.onCloseAll}
          aria-label="Close all and return to the feed"
        >
          ✕
        </button>
      </div>
      <span class="stack-depth-badge overlay-pill">
        {props.depth}/{props.maxDepth}
      </span>

      {/* One-time coaching hint on the first stack open */}
      <Show when={props.depth === 1 && !stackHintDismissed() && !props.closing}>
        <div class="stack-hint" role="status">
          <span>Related works. ← Back returns you here</span>
          <button type="button" onClick={dismissStackHint}>
            Got it
          </button>
        </div>
      </Show>
    </div>
  );
}
