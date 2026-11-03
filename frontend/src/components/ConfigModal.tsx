import { createSignal, For } from "solid-js";
import {
  blockedTags,
  addBlockedTag,
  removeBlockedTag,
  imageSize,
  setImageSize,
  feedViewMode,
  setFeedViewMode,
  artistViewMode,
  setArtistViewMode,
  maxStackDepth,
  setMaxStackDepth,
  normalizeMaxStackDepth,
} from "../store";
import BaseModal from "./BaseModal";

export default function ConfigModal(props: { onClose: () => void }) {
  const [input, setInput] = createSignal("");
  // Depth box draft: a field controlled straight from the store would
  // snap back to 10 the moment it's cleared (0/empty normalize to the
  // default), making "clear and retype" impossible. Every valid keystroke
  // still applies immediately — same rule as the view-mode pills — and
  // blur normalizes whatever is left in the box.
  const [depthInput, setDepthInput] = createSignal(String(maxStackDepth()));

  function add(e: Event) {
    e.preventDefault();
    addBlockedTag(input());
    setInput("");
  }

  function onDepthInput(raw: string) {
    setDepthInput(raw);
    const trimmed = raw.trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
      setMaxStackDepth(trimmed);
    }
  }

  function onDepthBlur() {
    const v = normalizeMaxStackDepth(depthInput());
    setMaxStackDepth(v);
    setDepthInput(String(v));
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
        <h3>View</h3>
        <p class="hint">
          Feeds and artist pages render as the default full-screen strip
          or a compact thumbnail grid. Stacks and the recommendations
          modal always stay strip.
        </p>
        <div class="config-view-row" data-testid="feed-view-row">
          <span class="config-view-label">Feeds</span>
          <button
            type="button"
            class={
              feedViewMode() !== "grid" ? "mode-pill active" : "mode-pill"
            }
            onClick={() => setFeedViewMode("strip")}
          >
            Strip
          </button>
          <button
            type="button"
            class={
              feedViewMode() === "grid" ? "mode-pill active" : "mode-pill"
            }
            onClick={() => setFeedViewMode("grid")}
          >
            Grid
          </button>
        </div>
        <div class="config-view-row" data-testid="artist-view-row">
          <span class="config-view-label">Artist pages</span>
          <button
            type="button"
            class={
              artistViewMode() !== "grid" ? "mode-pill active" : "mode-pill"
            }
            onClick={() => setArtistViewMode("strip")}
          >
            Strip
          </button>
          <button
            type="button"
            class={
              artistViewMode() === "grid" ? "mode-pill active" : "mode-pill"
            }
            onClick={() => setArtistViewMode("grid")}
          >
            Grid
          </button>
        </div>

        <h3>Stack depth</h3>
        <p class="hint">
          How many related views and tag-search pages can stack up. The
          same limit applies to both; 0 = default (10).
        </p>
        <div class="config-view-row" data-testid="max-depth-row">
          <label class="config-view-label" for="max-depth-input">
            Max depth
          </label>
          <input
            id="max-depth-input"
            data-testid="max-depth-input"
            class="config-depth-input"
            type="number"
            inputmode="numeric"
            min={1}
            max={30}
            value={depthInput()}
            onInput={(e) => onDepthInput(e.currentTarget.value)}
            onBlur={onDepthBlur}
          />
        </div>

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

        {/* Build stamp: which bundle is this device running? */}
        <p class="build-stamp">Build {__BUILD_STAMP__}</p>
      </section>
    </BaseModal>
  );
}
