import { Show } from "solid-js";

/**
 * Toast: new recommendations available (or a transient error).
 * Error toasts are inert — a button whose tap no-ops would be a
 * lying affordance.
 */
export default function FeedToast(props: {
  visible: () => boolean;
  opens: () => boolean;
  text: () => string;
  modalOpen: () => boolean;
  openRecs: () => void;
}) {
  return (
      <Show when={props.visible() && !props.modalOpen()}>
        <Show
          when={props.opens()}
          fallback={
            <div class="toast" role="status">
              {props.text()}
            </div>
          }
        >
          <button type="button" class="toast" onClick={props.openRecs}>
            {props.text()}
          </button>
        </Show>
      </Show>
  );
}
