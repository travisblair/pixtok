import { createSignal, onCleanup } from "solid-js";

/**
 * Transient toast state (8s auto-hide). Error toasts are inert
 * (opensRecs=false) — callers render them as a plain div, never a
 * button whose tap would no-op.
 */
export function useToast() {
  const [visible, setVisible] = createSignal(false);
  const [text, setText] = createSignal("New recommendations loaded");
  const [opens, setOpens] = createSignal(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  function show(toastText: string, opensRecs = true) {
    setText(toastText);
    setOpens(opensRecs);
    setVisible(true);
    clearTimeout(timer);
    timer = setTimeout(() => setVisible(false), 8000);
  }

  function hide() {
    setVisible(false);
    clearTimeout(timer);
  }

  return { visible, text, opens, show, hide };
}
