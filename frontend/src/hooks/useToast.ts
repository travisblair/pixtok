import { createSignal, onCleanup } from "solid-js";

/**
 * Transient toast state (8s auto-hide). Error toasts are inert
 * (opensRecs=false) — callers render them as a plain div, never a
 * button whose tap would no-op. A sticky toast skips the auto-hide
 * timer entirely and stays until hidden or the page reloads (used by
 * the bookmark-move completion notice — the pile only updates on
 * reload, so the confirmation must outlive the 8s window).
 */
export function useToast() {
  const [visible, setVisible] = createSignal(false);
  const [text, setText] = createSignal("New recommendations loaded");
  const [opens, setOpens] = createSignal(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  function show(toastText: string, opensRecs = true, sticky = false) {
    setText(toastText);
    setOpens(opensRecs);
    setVisible(true);
    clearTimeout(timer);
    if (!sticky) {
      timer = setTimeout(() => setVisible(false), 8000);
    }
  }

  function hide() {
    setVisible(false);
    clearTimeout(timer);
  }

  return { visible, text, opens, show, hide };
}
