import { Show } from "solid-js";

export interface MoveProgress {
  done: number;
  total: number;
}

/**
 * Bookmarks → selection chrome. Rendered by App only on the bookmarks
 * tab's PUBLIC pile (the pile the move reads from). Not inside
 * FeedHeader: the header's layout stays untouched, and the bar is the
 * single owner of selection affordances.
 *
 * Idle: a "Select" pill. Selecting: select-all / deselect-all / count /
 * move action / done. Running: progress + Cancel (stops at the next
 * work boundary; the in-flight work completes).
 */
export default function SelectionBar(props: {
  selectionMode: () => boolean;
  selectedCount: () => number;
  running: () => boolean;
  progress: () => MoveProgress;
  onEnter: () => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onMove: () => void;
  onCancel: () => void;
  onExit: () => void;
}) {
  return (
    <div class="selection-bar">
      <Show
        when={props.selectionMode()}
        fallback={
          <button
            type="button"
            class="mode-pill selection-enter"
            onClick={props.onEnter}
          >
            Select
          </button>
        }
      >
        <Show
          when={props.running()}
          fallback={
            <div class="selection-bar-row no-scrollbar">
              <button
                type="button"
                class="mode-pill"
                onClick={props.onSelectAll}
              >
                Select all
              </button>
              <button
                type="button"
                class="mode-pill"
                onClick={props.onDeselectAll}
              >
                Deselect all
              </button>
              <span class="selection-count">
                {props.selectedCount()} selected
              </span>
              <button
                type="button"
                class="mode-pill active move-action"
                disabled={props.selectedCount() === 0}
                onClick={props.onMove}
              >
                Move to private ({props.selectedCount()})
              </button>
              <button
                type="button"
                class="mode-pill"
                onClick={props.onExit}
                aria-label="Exit selection mode"
              >
                Done
              </button>
            </div>
          }
        >
          <div class="selection-bar-row move-progress">
            <span>
              Moving {props.progress().done}/{props.progress().total}
            </span>
            <button
              type="button"
              class="mode-pill move-cancel"
              onClick={props.onCancel}
            >
              Cancel
            </button>
          </div>
        </Show>
      </Show>
    </div>
  );
}
