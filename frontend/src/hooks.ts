import { createEffect, createSignal, onCleanup } from "solid-js";

/**
 * Infinite-scroll sentinel: an IntersectionObserver rooted on the
 * nearest .feed-container, re-subscribing whenever loadability changes.
 *
 * Every feed screen (main feed, search, artist, related) used to carry
 * its own copy of this observer wiring — including the explicit-root
 * Chromium gotcha and the SolidJS early-return pitfall. Single-sourced
 * here instead.
 *
 * Pitfalls preserved from the copies:
 * - `root` MUST be the scroll container: with the implicit viewport
 *   root, Chromium clamps rootMargin, so a 2400px prefetch margin never
 *   fires until the sentinel actually enters the viewport.
 * - canLoad() must be called UNCONDITIONALLY in the effect body — it is
 *   the tracked dependency. If a guard returns before reading it, the
 *   effect never re-subscribes when state changes (the "infinite scroll
 *   stays dead after gate unlock" bug).
 */
export function useFeedSentinel(
  getSentinel: () => HTMLDivElement | undefined,
  canLoad: () => boolean,
  loadMore: () => void,
  rootMargin = "2400px"
) {
  let observer: IntersectionObserver | undefined;
  onCleanup(() => observer?.disconnect());
  createEffect(() => {
    observer?.disconnect(); // always release the previous observer first
    // Read canLoad() FIRST and unconditionally — it is the tracked
    // dependency. The original bug this pattern preserves the fix for:
    // with the gate, the first render has no sentinel (UI hidden while
    // locked); if the effect returns before ANY tracked read, it never
    // re-subscribes when the sentinel mounts after unlock, and infinite
    // scroll stays dead.
    const loadable = canLoad();
    const sentinel = getSentinel();
    if (!sentinel || !loadable) return;
    const root = sentinel.closest<HTMLElement>(".feed-container") ?? undefined;
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && canLoad()) {
          loadMore();
        }
      },
      { root, rootMargin }
    );
    observer.observe(sentinel);
  });
}

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
