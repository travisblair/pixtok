import { For, Show } from "solid-js";
import type { PixivIllust } from "../types";
import FeedCard from "./FeedCard";

export default function RecsModal(props: {
  recs: PixivIllust[];
  sourceTitle?: string;
  obscured?: boolean; // covered by a stack/artist layer — unload images
  onClose: () => void;
  onImageTap?: (illust: PixivIllust) => void;
  onArtistTap?: (illust: PixivIllust) => void;
  onTagsTap?: (illust: PixivIllust) => void;
  onTagOpen?: (tag: string) => void;
}) {
  return (
    <div class="recs-modal">
      {/* Reuses .feed-container snap CSS; FeedCard's IntersectionObserver
          roots itself via closest(".feed-container") so cards inside the
          modal observe THIS container, not the main feed. */}
      <div class="feed-container recs-feed">
        <For each={props.recs}>
          {(illust) => (
            <FeedCard
              illust={illust}
              onTap={props.onImageTap}
              onArtistTap={props.onArtistTap}
              onTagsTap={props.onTagsTap}
              onTagOpen={props.onTagOpen}
              suppressImages={props.obscured}
            />
          )}
        </For>
      </div>
      <button type="button" class="recs-close" onClick={props.onClose} aria-label="Close recommendations">
        ✕
      </button>
      <Show when={props.sourceTitle}>
        <div class="recs-source overlay-pill" aria-live="polite">
          Recs for: {props.sourceTitle}
        </div>
      </Show>
    </div>
  );
}
