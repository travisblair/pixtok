import { onCleanup, onMount } from "solid-js";

// Edge-back gesture (iOS push-navigation convention): touch down within
// the left edge zone and drag right to pop the top layer — the same
// action as the Back pill. The gesture claims the touch only after
// clearly horizontal travel, so vertical layer scrolls and the native
// multi-page sliders are never stolen; multi-page sliders win the edge
// zone outright (an edge start on a card with horizontal overflow arms
// nothing).
const EDGE_BACK_ZONE = 24; // px from the left edge where the gesture arms
const EDGE_BACK_ARM_DX = 8; // horizontal travel before it claims the touch
const EDGE_BACK_POP_DX = 72; // release displacement that pops
const EDGE_BACK_FLING_DX = 36; // min displacement for the velocity path
const EDGE_BACK_FLING_V = 0.55; // px/ms
// One pop per gesture, and never two within one close animation: iOS
// can emit duplicate/canceled touch sequences from a single physical
// swipe, and a stray second touchend after the layer is gone would pop
// the NEXT level too ("swiped from layer 3, landed on layer 1").
const EDGE_BACK_POP_COOLDOWN = 350; // ms ≈ close animation + margin

/**
 * Edge-back gesture: document-level touch listeners (installed in
 * onMount, removed in onCleanup) plus the per-gesture state. touchmove
 * MUST stay passive:false — the gesture preventDefaults once it claims
 * a horizontal drag, and iOS Safari's native edge-back would otherwise
 * win the race.
 *
 * Everything it needs from the layer machine — the gate signal, the
 * open-order keys, the pop action, the breadcrumb logger — is passed in
 * as accessors/callbacks, so the layer state stays owned by App.
 */
export function useEdgeBackGesture(opts: {
  gateLocked: () => boolean;
  layerSeq: () => string[];
  popTopLayer: () => void;
  logEvent: (scope: string, msg: string, data?: unknown) => void;
}) {
  const { gateLocked, layerSeq, popTopLayer, logEvent } = opts;

  // ── Edge-back gesture ───────────────────────────────────────────────
  // See the constants above for thresholds. Armed on a left-edge touch
  // when layers are open; claims the touch once horizontal; pops the
  // top layer on a long drag or a fast fling. Every interesting state
  // transition leaves a breadcrumb (POST /api/log) so the server
  // journal can replay what the phone believed happened.
  let edgePan: { x: number; y: number; t: number; active: boolean } | null = null;
  let lastEdgePop = 0; // performance.now() of the last gesture pop

  function edgeBackStart(e: TouchEvent) {
    edgePan = null;
    if (gateLocked() || e.touches.length !== 1 || layerSeq().length === 0) return;
    const touch = e.touches[0];
    if (touch.clientX > EDGE_BACK_ZONE) return;
    const target = e.target as Element | null;
    // Native multi-page sliders own horizontal drags that start on
    // them — an edge start there must not arm the gesture. Single-page
    // cards (no horizontal overflow) fall through and arm normally.
    const pages = target?.closest?.(".card-pages");
    if (pages && pages.scrollWidth > pages.clientWidth + 1) {
      logEvent("gesture", "ignored-slider-owns-edge", { x: Math.round(touch.clientX) });
      return;
    }
    if (
      target?.closest?.(
        "button, a, input, textarea, .drawer, .modal-dialog, .modal-backdrop, .tag-popup, .toast, .gate-screen"
      )
    )
      return;
    edgePan = { x: touch.clientX, y: touch.clientY, t: performance.now(), active: false };
    logEvent("gesture", "armed", {
      x: Math.round(touch.clientX),
      layers: layerSeq().length,
    });
  }

  function edgeBackMove(e: TouchEvent) {
    if (!edgePan || e.touches.length !== 1) return;
    // A touch that starts in the edge zone with layers open belongs to
    // US from the very first move: preventDefault immediately, before
    // iOS Safari's native edge-back history gesture can win the race.
    // (When Safari's wins, the page navigates back via bfcache and
    // restores an older frozen state with fewer layers — the reported
    // "one swipe closed two layers", with zero gesture breadcrumbs.)
    // Tradeoff: an edge-zone-start vertical scroll inside a layer is
    // blocked too — the zone is 24px, layers only, acceptable.
    e.preventDefault();
    const touch = e.touches[0];
    const dx = touch.clientX - edgePan.x;
    const dy = touch.clientY - edgePan.y;
    if (!edgePan.active && dx > EDGE_BACK_ARM_DX && Math.abs(dx) > Math.abs(dy) * 1.2) {
      edgePan.active = true;
      logEvent("gesture", "claimed", { dx: Math.round(dx), dy: Math.round(dy) });
    }
  }

  function edgeBackCancel() {
    if (edgePan) logEvent("gesture", "canceled", { active: edgePan.active });
    edgePan = null;
  }

  function edgeBackEnd(e: TouchEvent) {
    if (!edgePan) return;
    const touch = e.changedTouches[0];
    const dx = touch ? touch.clientX - edgePan.x : 0;
    const dt = performance.now() - edgePan.t;
    const popped = edgePan.active;
    edgePan = null;
    if (!popped) {
      // An armed edge-touch that lifts BEFORE claiming (a stray tap at
      // the edge, or the touch stolen mid-drag) used to vanish from the
      // breadcrumbs — indistinguishable from an interrupted gesture.
      // Log it so the next "swipe felt weird" report has evidence
      // either way.
      logEvent("gesture", "end-no-pop", {
        dx: Math.round(dx),
        dt: Math.round(dt),
        claimed: false,
      });
      return;
    }
    const now = performance.now();
    const inCooldown = now - lastEdgePop < EDGE_BACK_POP_COOLDOWN;
    if (dx >= EDGE_BACK_POP_DX || (dx >= EDGE_BACK_FLING_DX && dx / dt > EDGE_BACK_FLING_V)) {
      if (inCooldown) {
        logEvent("gesture", "pop-suppressed", {
          dx: Math.round(dx),
          dt: Math.round(dt),
          reason: "cooldown",
        });
        return;
      }
      lastEdgePop = now;
      logEvent("gesture", "pop", {
        dx: Math.round(dx),
        dt: Math.round(dt),
        top: layerSeq().at(-1),
      });
      popTopLayer();
    } else {
      logEvent("gesture", "end-no-pop", { dx: Math.round(dx), dt: Math.round(dt) });
    }
  }

  onMount(() => {
    // Edge-back gesture: document-level so it works over every layer;
    // touchmove is non-passive because the gesture preventDefaults
    // once it claims a horizontal drag.
    document.addEventListener("touchstart", edgeBackStart, { passive: true });
    document.addEventListener("touchmove", edgeBackMove, { passive: false });
    document.addEventListener("touchend", edgeBackEnd);
    document.addEventListener("touchcancel", edgeBackCancel);
  });

  onCleanup(() => {
    document.removeEventListener("touchstart", edgeBackStart);
    document.removeEventListener("touchmove", edgeBackMove);
    document.removeEventListener("touchend", edgeBackEnd);
    document.removeEventListener("touchcancel", edgeBackCancel);
  });
}
