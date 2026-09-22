import { Show } from "solid-js";

/**
 * Red error toast — any failed request surfaces here for 2s;
 * tap to dismiss. Above every layer, modal, and the bottom
 * toast (z-120).
 */
export default function ErrorToast(props: {
  errorToastMsg: () => string | null;
  setErrorToastMsg: (value: string | null) => void;
}) {
  return (
      <Show when={props.errorToastMsg()}>
        {(msg) => (
          <div
            class="error-toast"
            role="alert"
            onClick={() => props.setErrorToastMsg(null)}
          >
            {msg()}
          </div>
        )}
      </Show>
  );
}
