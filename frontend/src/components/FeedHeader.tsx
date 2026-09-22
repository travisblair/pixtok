import { For, Show } from "solid-js";
import type { ContentMode, FeedType, RankingMode } from "../types";
import NavigationDrawer from "./NavigationDrawer";
import ContentPills from "./ContentPills";
import RankingSelector from "./RankingSelector";

/**
 * Header area: row 1 = burger + content pills, row 2 = the ranking
 * mode pills (below the burger).
 */
export default function FeedHeader(props: {
  feedType: () => FeedType;
  rankContent: () => ContentMode;
  rankMode: () => RankingMode;
  newestR18: () => boolean;
  topMode: () => ContentMode;
  bookmarkVis: () => "public" | "private";
  bookmarkTags: () => { name: string; count: number }[];
  bookmarkTag: () => string;
  changeFeedType: (type: FeedType) => void;
  changeRankingContent: (content: ContentMode) => void;
  changeRankingMode: (mode: RankingMode) => void;
  changeNewestR18: (content: ContentMode) => void;
  changeTopMode: (content: ContentMode) => void;
  changeBookmarkVis: (vis: "public" | "private") => void;
  selectBookmarkTag: (tag: string) => void;
  openSearch: () => void;
  setConfigOpen: (open: boolean) => void;
  setLoginOpen: (open: boolean) => void;
}) {
  return (
        <div class="header-bar">
          <div class="header-row">
            <NavigationDrawer
              feedType={props.feedType()}
              onChange={props.changeFeedType}
              onSearch={props.openSearch}
              onSettings={() => props.setConfigOpen(true)}
              onLogin={() => props.setLoginOpen(true)}
            />
            <Show when={props.feedType() === "illustrations"}>
              <ContentPills
                content={props.rankContent()}
                onChange={props.changeRankingContent}
              />
            </Show>
            <Show when={props.feedType() === "newest"}>
              <ContentPills
                content={props.newestR18() ? "r18" : "all"}
                onChange={props.changeNewestR18}
              />
            </Show>
            <Show when={props.feedType() === "top"}>
              <ContentPills content={props.topMode()} onChange={props.changeTopMode} />
            </Show>
            <Show when={props.feedType() === "bookmarks"}>
              <div class="mode-pill-row no-scrollbar fade-edges">
                <button
                  type="button"
                  class={
                    props.bookmarkVis() === "public" ? "mode-pill active" : "mode-pill"
                  }
                  onClick={() => props.changeBookmarkVis("public")}
                >
                  Public
                </button>
                <button
                  type="button"
                  class={
                    props.bookmarkVis() === "private" ? "mode-pill active" : "mode-pill"
                  }
                  onClick={() => props.changeBookmarkVis("private")}
                >
                  Private
                </button>
              </div>
              <Show when={props.bookmarkVis() === "public" && props.bookmarkTags().length > 0}>
                <div class="mode-pill-row no-scrollbar fade-edges">
                <For each={props.bookmarkTags()}>
                  {(tag) => (
                    <button
                      type="button"
                      class={
                        props.bookmarkTag() === tag.name
                          ? "mode-pill active"
                          : "mode-pill"
                      }
                      onClick={() => props.selectBookmarkTag(tag.name)}
                    >
                      {tag.name}
                    </button>
                  )}
                </For>
                </div>
              </Show>
            </Show>
          </div>
          <Show when={props.feedType() === "illustrations"}>
            <RankingSelector
              content={props.rankContent()}
              mode={props.rankMode()}
              onChange={props.changeRankingMode}
            />
          </Show>
        </div>
  );
}
