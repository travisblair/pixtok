// TEMPORARY diagnostic instrumentation (tap-warning saga, Nov 2026).
// Captures the RAW input event sequence for touch gestures originating
// on cards/grid cells so the backend journal can replay exactly what the
// browser delivered — touchstart/touchend plus any synthesized clicks,
// with targets resolved at fire time. Strip this file once the
// double-delivery path is identified.
//
// Deliberately not routed through the app's request() wrapper: a
// logging failure must never surface as a toast or gate re-lock.
import { logEvent } from "./api/client";

const CARD_SELECTOR =
  ".feed-card, .grid-cell, .card-image, .related-view, .artist-view";
const MAX_LINES = 150;

/** Short stable name for an event target: tag + top classes + layer. */
export function summarizeTarget(el: EventTarget | null): string {
  const node = el as HTMLElement | null;
  if (!node || typeof node.className !== "string") return "none";
  const cls = node.className
    .toString()
    .split(" ")
    .filter((c) => c && !/^\d/.test(c))
    .slice(0, 2)
    .join(".");
  const inRelated = !!node.closest?.(".related-view");
  return `${node.tagName}.${cls}${inRelated ? "[rel]" : ""}`;
}

export function installTapTrace() {
  if (typeof document === "undefined") return;

  let lines = 0;
  let start: { x: number; y: number; t: number; tgt: string } | null = null;
  let moved = false;

  const emit = (data: Record<string, unknown>) => {
    if (lines >= MAX_LINES) return;
    lines++;
    logEvent("gesture", "taptrace", data);
  };

  const onCard = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    return !!el && typeof el.closest === "function" && !!el.closest(CARD_SELECTOR);
  };

  document.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      if (!t || !onCard(e.target)) {
        start = null;
        return;
      }
      start = {
        x: t.clientX,
        y: t.clientY,
        t: performance.now(),
        tgt: summarizeTarget(e.target),
      };
      moved = false;
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!start) return;
      const t = e.touches[0];
      if (!t) return;
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) moved = true;
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "touchend",
    (e) => {
      if (!start) return;
      const t = e.changedTouches[0];
      const now = performance.now();
      emit({
        ev: "touchend",
        t0: Math.round(start.t),
        dt: Math.round(now - start.t),
        moved,
        tgt: start.tgt,
        tgtEnd: summarizeTarget(e.target),
        x: t ? Math.round(t.clientX) : undefined,
        y: t ? Math.round(t.clientY) : undefined,
      });
      start = null;
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "touchcancel",
    () => {
      if (!start) return;
      emit({ ev: "touchcancel", t: Math.round(performance.now()), tgt: start.tgt });
      start = null;
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "click",
    (e) => {
      if (!onCard(e.target)) return;
      emit({
        ev: "click",
        t: Math.round(performance.now()),
        tgt: summarizeTarget(e.target),
        ptr: (e as PointerEvent).pointerType ?? null,
      });
    },
    { capture: true, passive: true }
  );
}
