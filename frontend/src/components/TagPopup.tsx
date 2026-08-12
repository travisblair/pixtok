import { For, Show } from "solid-js";
import type { PixivIllust } from "../types";
import { normalizeTagPairs } from "../helpers";
import { blockedTags, addBlockedTag, removeBlockedTag } from "../store";
import BaseModal from "./BaseModal";

/**
 * Popup listing a work's tags. Tapping a tag blocks it (added to the
 * shared blocked-tags store — the Settings modal reads the same list, so
 * new blocks appear there immediately). Tapping an already-blocked tag
 * unblocks it. The popup stays open so several tags can be blocked in
 * one visit; the filter applies to feeds as they load (option A — the
 * currently-visible feed is untouched).
 *
 * Tags render their Pixiv translation (translated_name) as a small
 * second line under the original when one exists.
 */
export default function TagPopup(props: {
  illust: PixivIllust;
  onToggle: (tag: string, blocked: boolean) => void; // toast hook
  onClose: () => void;
}) {
  const tags = () => normalizeTagPairs(props.illust);

  function toggle(tag: string) {
    const blocked = blockedTags().includes(tag.toLowerCase());
    if (blocked) {
      removeBlockedTag(tag);
      props.onToggle(tag, false);
    } else {
      addBlockedTag(tag);
      props.onToggle(tag, true);
    }
  }

  return (
    <BaseModal
      title="Tags"
      closeLabel="Close tags"
      onClose={props.onClose}
      footer={
        <button type="button" onClick={props.onClose}>
          Done
        </button>
      }
    >
      <section>
        <p class="hint">
          Tap a tag to block it — works carrying it disappear from new
          content. Tap again to unblock.
        </p>

        <Show
          when={tags().length > 0}
          fallback={<p class="hint">This work has no tags.</p>}
        >
          <div class="tag-chip-list">
            <For each={tags()}>
              {(tag) => (
                <button
                  type="button"
                  class={
                    blockedTags().includes(tag.name.toLowerCase())
                      ? "tag-chip blocked"
                      : "tag-chip"
                  }
                  onClick={() => toggle(tag.name)}
                >
                  <span class="tag-chip-name">#{tag.name}</span>
                  <Show when={tag.translated}>
                    <span class="tag-chip-translation">{tag.translated}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </section>
    </BaseModal>
  );
}
