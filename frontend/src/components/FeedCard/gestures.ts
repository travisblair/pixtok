// Touch-gesture primitives for FeedCard / GridFeed — extracted so the
// tap-tracking and pinch rules are unit-testable without a browser.
//
// Two independent detectors:
//
//   createTapTracker   — touch-only single/double tap recognition. A
//                        single tap is DEFERRED by the double-tap window
//                        (a second tap must be able to cancel it); two
//                        taps inside window+slop fire onDoubleTap and
//                        cancel the pending single. Synthetic clicks that
//                        iOS/Chromium fire after touchend are absorbed so
//                        a touch tap never double-fires the stack-open
//                        click handler; desktop MouseEvents never enter
//                        this path and stay immediate.
//
//   createPinchDetector — exactly two touchpoints on the card; spread
//                        beyond the threshold reports immersive=true,
//                        contraction below it reports immersive=false.
//                        It also preventDefaults 2-finger touchmove so
//                        the page's native pinch-zoom can't fight the
//                        gesture (the listener must be passive:false).
//
// Both detectors take event-shaped objects instead of TouchEvent so
// jsdom (which has TouchEvent but no Touch constructor) can drive them
// with plain coordinates.

export interface TouchPointLike {
  clientX: number;
  clientY: number;
}

/** The subset of TouchEvent the detectors read. */
export interface GestureEventLike {
  touches?: ArrayLike<TouchPointLike>;
  changedTouches?: ArrayLike<TouchPointLike>;
  target?: EventTarget | null;
  preventDefault?: () => void;
}

export const TAP_WINDOW_MS = 300;
export const TAP_SLOP_PX = 10;
/**
 * Distance between the TWO taps of a double-tap. Deliberately looser
 * than TAP_SLOP_PX: a finger never lands on the same pixel twice — real
 * double-taps land ~10-30px apart. If the between-taps check reuses the
 * 10px in-tap slop, most real double-taps are rejected, and the rejected
 * second tap first DELIVERS the deferred single (stack opens) and then
 * arms its own single (same work pushed again → "already open" refusal).
 */
export const DOUBLE_TAP_SLOP_PX = 30;
/** How long after a touch tap synthetic clicks are swallowed. */
export const CLICK_SUPPRESS_MS = 600;
export const PINCH_THRESHOLD_PX = 70;

function distance(a: TouchPointLike, b: TouchPointLike): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export interface TapTrackerOptions {
  onSingleTap: () => void;
  onDoubleTap: (x: number, y: number) => void;
  /** True when the touch started on an interactive child — never a tap. */
  isIgnored?: (target: EventTarget | null) => boolean;
  windowMs?: number;
  /** Max finger movement WITHIN one tap (moved → not a tap). */
  slopPx?: number;
  /** Max distance BETWEEN the two taps of a double-tap (see the
   *  DOUBLE_TAP_SLOP_PX comment). */
  doubleTapSlopPx?: number;
}

export function createTapTracker(opts: TapTrackerOptions) {
  const windowMs = opts.windowMs ?? TAP_WINDOW_MS;
  const slopPx = opts.slopPx ?? TAP_SLOP_PX;
  const doubleTapSlop = opts.doubleTapSlopPx ?? DOUBLE_TAP_SLOP_PX;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let lastTapAt = 0;
  let lastX = 0;
  let lastY = 0;
  let startX = 0;
  let startY = 0;
  let active = false;
  let moved = false;
  let ignored = false;
  // Timestamp window, not a boolean: a double-tap produces TWO synthetic
  // clicks and a boolean flag would only eat the first one.
  let suppressUntil = 0;

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  /** Drop a pending single tap and the double-tap anchor (scroll etc.). */
  function cancelPending() {
    pending = false;
    clearTimer();
    lastTapAt = 0;
  }

  /**
   * A second tap that is NOT a double-tap is its own tap: deliver the
   * deferred first one now instead of silently losing it.
   */
  function deliverPendingSingle() {
    if (!pending) return;
    pending = false;
    clearTimer();
    lastTapAt = 0;
    opts.onSingleTap();
  }

  function onTouchStart(e: GestureEventLike) {
    const count = e.touches?.length ?? 0;
    if (count !== 1) {
      // Multi-finger gesture: not a tap — never let a pending single fire
      // in the middle of a pinch.
      active = false;
      cancelPending();
      return;
    }
    const t = e.touches![0];
    ignored = opts.isIgnored ? opts.isIgnored(e.target ?? null) : false;
    active = !ignored;
    moved = false;
    startX = t.clientX;
    startY = t.clientY;
  }

  function onTouchMove(e: GestureEventLike) {
    if (!active) return;
    if ((e.touches?.length ?? 0) > 1) {
      active = false;
      cancelPending();
      return;
    }
    const t = e.touches?.[0];
    if (!t) return;
    if (distance(t, { clientX: startX, clientY: startY }) > slopPx) {
      // A slider swipe / scroll, not a tap. Cancel the pending action so
      // a fast swipe can never open a stack when the finger lifts.
      moved = true;
      cancelPending();
    }
  }

  function onTouchEnd(e: GestureEventLike) {
    if (!active) return;
    active = false;
    if (ignored || moved) return;
    const t = e.changedTouches?.[0];
    const x = t?.clientX ?? startX;
    const y = t?.clientY ?? startY;
    // Any handled touch tap gets a synthetic click after touchend — eat
    // everything in this window (double-tap fires two of them).
    suppressUntil = Date.now() + CLICK_SUPPRESS_MS;
    const now = Date.now();
    if (
      lastTapAt !== 0 &&
      now - lastTapAt <= windowMs &&
      Math.hypot(x - lastX, y - lastY) <= doubleTapSlop
    ) {
      cancelPending();
      opts.onDoubleTap(x, y);
      return;
    }
    clearTimer();
    if (pending) {
      deliverPendingSingle();
    }
    lastTapAt = now;
    lastX = x;
    lastY = y;
    // Defer the single tap: the second tap must be able to cancel it.
    pending = true;
    timer = setTimeout(() => {
      timer = undefined;
      pending = false;
      lastTapAt = 0;
      opts.onSingleTap();
    }, windowMs);
  }

  function onTouchCancel() {
    active = false;
    cancelPending();
  }

  /**
   * true → handle this click normally (desktop MouseEvent); false → it is
   * the synthetic click after a touch tap/double-tap we already handled.
   *
   * Real mouse/pen clicks bypass the time window: a pinch (which arms
   * suppression) must not swallow the user's next genuine click. The
   * synthetic click a touch produces carries pointerType "touch" in
   * Chromium; WebKit's bare MouseEvent has no pointerType and falls back
   * to the window.
   */
  function absorbClick(e?: { pointerType?: string }): boolean {
    const pointerType = e?.pointerType;
    if (pointerType && pointerType !== "touch") return true;
    return Date.now() > suppressUntil;
  }

  /** Swallow clicks after a gesture that isn't a tap (pinch). */
  function suppressClicks(ms = CLICK_SUPPRESS_MS) {
    suppressUntil = Math.max(suppressUntil, Date.now() + ms);
  }

  function dispose() {
    clearTimer();
    active = false;
  }

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
    absorbClick,
    suppressClicks,
    cancelPending,
    dispose,
  };
}

export interface PinchDetectorOptions {
  onPinch: (immersive: boolean) => void;
  /** True when the touch started on an interactive child — never a pinch. */
  isIgnored?: (target: EventTarget | null) => boolean;
  thresholdPx?: number;
}

export function createPinchDetector(opts: PinchDetectorOptions) {
  const threshold = opts.thresholdPx ?? PINCH_THRESHOLD_PX;
  let active = false;
  let startDist = 0;
  let firedOn = false;
  let firedOff = false;

  function reset() {
    active = false;
    startDist = 0;
    firedOn = false;
    firedOff = false;
  }

  function onTouchStart(e: GestureEventLike) {
    const touches = e.touches;
    const count = touches?.length ?? 0;
    if (count !== 2) {
      // <2: previous gesture ended. >2: too many fingers, not ours.
      if (count < 2) reset();
      else active = false;
      return;
    }
    if (opts.isIgnored?.(e.target ?? null)) {
      reset();
      return;
    }
    // iOS-specific: Safari commits to native pinch-zoom the moment the
    // second finger lands — it fires touchcancel and the page never sees
    // the gesture. preventDefault on the 2-finger touchstart stops the
    // recognition, so the listener MUST be passive:false (FeedCard wires
    // it that way). One-finger touchstarts are never prevented (feed
    // scroll + slider swipes stay native).
    e.preventDefault?.();
    active = true;
    firedOn = false;
    firedOff = false;
    startDist = distance(touches![0], touches![1]);
  }

  function onTouchMove(e: GestureEventLike) {
    const touches = e.touches;
    if ((touches?.length ?? 0) !== 2) return;
    // Always kill native page pinch-zoom over the card, even when this
    // particular pinch started on a control (no gesture action then).
    e.preventDefault?.();
    if (!active) return;
    const delta = distance(touches![0], touches![1]) - startDist;
    if (!firedOn && delta >= threshold) {
      firedOn = true;
      opts.onPinch(true);
    } else if (!firedOff && delta <= -threshold) {
      firedOff = true;
      opts.onPinch(false);
    }
  }

  function onTouchEnd(e: GestureEventLike) {
    if ((e.touches?.length ?? 0) < 2) reset();
  }

  function onTouchCancel() {
    reset();
  }

  function dispose() {
    reset();
  }

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, dispose };
}
