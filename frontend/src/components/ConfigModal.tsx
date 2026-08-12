import { createSignal, For } from "solid-js";
import {
  blockedTags,
  addBlockedTag,
  removeBlockedTag,
  imageSize,
  setImageSize,
} from "../store";
import BaseModal from "./BaseModal";

export default function ConfigModal(props: { onClose: () => void }) {
  const [input, setInput] = createSignal("");

  function add(e: Event) {
    e.preventDefault();
    addBlockedTag(input());
    setInput("");
  }

  return (
    <BaseModal
      title="Settings"
      closeLabel="Close settings"
      onClose={props.onClose}
      footer={
        <button type="button" onClick={props.onClose}>
          Done
        </button>
      }
    >
      <section>
        <h3>Image quality</h3>
        <p class="hint">
          Data saver loads smaller images (540px where the feed has
          them) — saves bandwidth on cellular. Full loads the
          full-resolution pages.
        </p>
        <div class="config-pill-row">
          <button
            type="button"
            class={imageSize() !== "medium" ? "mode-pill active" : "mode-pill"}
            onClick={() => setImageSize("large")}
          >
            Full
          </button>
          <button
            type="button"
            class={imageSize() === "medium" ? "mode-pill active" : "mode-pill"}
            onClick={() => setImageSize("medium")}
          >
            Data saver
          </button>
        </div>

        <h3>Blocked tags</h3>
        <p class="hint">
          Works carrying any of these tags are hidden from every feed.
          Pixiv gates tag filtering behind premium — pixtok does it
          locally instead.
        </p>

        <form class="blocked-tag-form" onSubmit={add}>
          <input
            type="text"
            placeholder="e.g. swimsuit"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            aria-label="Tag to block"
          />
          <button type="submit">Add</button>
        </form>

        <ul class="blocked-tags">
          <For each={blockedTags()}>
            {(tag) => (
              <li>
                <span class="blocked-tag-pill">#{tag}</span>
                <button
                  type="button"
                  class="blocked-tag-remove"
                  onClick={() => removeBlockedTag(tag)}
                  aria-label={`Unblock ${tag}`}
                >
                  ✕
                </button>
              </li>
            )}
          </For>
        </ul>
        {blockedTags().length === 0 && (
          <p class="hint">No blocked tags yet.</p>
        )}
      </section>
    </BaseModal>
  );
}
