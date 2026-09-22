import { For, Show } from "solid-js";
import type { FeedType, PixivIllust } from "../types";
import type { ViewMode } from "../store";
import FeedCard from "./FeedCard/FeedCard";
import GridFeed from "./GridFeed";

/**
 * Feed body: the strip (FeedCard) / grid (GridFeed) switch plus the
 * infinite-scroll sentinel. The sentinel element itself is owned by the
 * caller (App) — useFeedSentinel lives there and receives the element
 * through the sentinelRef callback.
 */
export default function FeedArea(props: {
  illusts: () => PixivIllust[];
  loading: () => boolean;
  loadError: () => boolean;
  nextUrl: () => string | null;
  feedType: () => FeedType;
  feedViewMode: () => ViewMode;
  sentinelRef: (el: HTMLDivElement) => void;
  handleLike: (illust: PixivIllust) => void;
  handleUnlike: (illust: PixivIllust) => void;
  pushRelated: (illust: PixivIllust) => void;
  openArtist: (illust: PixivIllust) => void;
  setTagsIllust: (illust: PixivIllust) => void;
  openTagPage: (tag: string) => void;
  loadMore: (fresh?: boolean) => void;
}) {
  return (
    <>
        <Show
          when={props.illusts().length > 0 || props.loading()}
          fallback={
            <div class="empty-feed">
              <span>Nothing here yet</span>
              <button
                type="button"
                class="mode-pill"
                onClick={() => void props.loadMore()}
              >
                Retry
              </button>
            </div>
          }
        >
          <Show
            when={props.feedViewMode() === "strip"}
            fallback={
              <GridFeed
                illusts={props.illusts()}
                onLike={props.handleLike}
                onUnlike={props.handleUnlike}
                onTap={props.pushRelated}
              />
            }
          >
            <For each={props.illusts()}>
              {(illust) => (
                <FeedCard
                  illust={illust}
                  onLike={props.handleLike}
                  onUnlike={props.handleUnlike}
                  onTap={props.pushRelated}
                  onArtistTap={props.openArtist}
                  onTagsTap={props.setTagsIllust}
                  onTagOpen={props.openTagPage}
                />
              )}
            </For>
          </Show>
        </Show>

        {/* Sentinel for infinite scroll — full-height while the feed is
            empty so the initial-load spinner sits centered on screen. */}
        <div
          ref={props.sentinelRef}
          class={
            props.loading() && props.illusts().length === 0
              ? "feed-sentinel feed-sentinel-full"
              : "feed-sentinel"
          }
        >
          {props.loading() && <div class="spinner" />}
          {props.loadError() && !props.loading() && (
            <button type="button" class="mode-pill" onClick={() => void props.loadMore()}>
              Couldn't load — tap to retry
            </button>
          )}
          {!props.loading() && !props.loadError() && props.feedType() === "illustrations" && !props.nextUrl() && (
            <span>End of feed</span>
          )}
        </div>
    </>
  );
}
