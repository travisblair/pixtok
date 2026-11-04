import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createTapTracker,
  createPinchDetector,
  TAP_WINDOW_MS,
  CLICK_SUPPRESS_MS,
  PINCH_THRESHOLD_PX,
} from "./gestures";

interface P {
  clientX: number;
  clientY: number;
}

/** Minimal TouchEvent shape the factories consume. */
function gesture(
  touches: P[],
  changedTouches: P[] = touches,
  target: EventTarget | null = null
) {
  return {
    touches,
    changedTouches,
    target,
    preventDefault: vi.fn(),
  };
}

function at(x: number, y = 0): P {
  return { clientX: x, clientY: y };
}

describe("createTapTracker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeTracker(overrides: Partial<Parameters<typeof createTapTracker>[0]> = {}) {
    const onSingleTap = vi.fn();
    const onDoubleTap = vi.fn();
    const tracker = createTapTracker({ onSingleTap, onDoubleTap, ...overrides });
    return { tracker, onSingleTap, onDoubleTap };
  }

  it("defers a single tap by the double-tap window", () => {
    const { tracker, onSingleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    expect(onSingleTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TAP_WINDOW_MS - 1);
    expect(onSingleTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSingleTap).toHaveBeenCalledTimes(1);
  });

  it("two taps inside window+slop fire onDoubleTap and cancel the single", () => {
    const { tracker, onSingleTap, onDoubleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    vi.advanceTimersByTime(150);
    tracker.onTouchStart(gesture([at(103, 104)]));
    tracker.onTouchEnd(gesture([], [at(103, 104)]));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TAP_WINDOW_MS * 3);
    expect(onSingleTap).not.toHaveBeenCalled();
  });

  it("two taps ~20px apart (normal finger drift) still fire onDoubleTap", () => {
    const { tracker, onSingleTap, onDoubleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    vi.advanceTimersByTime(150);
    tracker.onTouchStart(gesture([at(120, 108)]));
    tracker.onTouchEnd(gesture([], [at(120, 108)]));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TAP_WINDOW_MS * 3);
    expect(onSingleTap).not.toHaveBeenCalled();
  });

  it("two taps ~45px apart (fast thumb drift) still fire onDoubleTap", () => {
    const { tracker, onSingleTap, onDoubleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    vi.advanceTimersByTime(200);
    tracker.onTouchStart(gesture([at(145, 110)]));
    tracker.onTouchEnd(gesture([], [at(145, 110)]));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TAP_WINDOW_MS * 3);
    expect(onSingleTap).not.toHaveBeenCalled();
  });

  it("absorbs a delayed WebKit synthetic click (no pointerType) after the single fires", () => {
    // THE iOS race: the deferred single opens the stack (700ms), the
    // render delays WebKit's synthetic click past any fixed window, and
    // the click then re-opens the same work ("already open"). The click
    // BUDGET absorbs it however late it arrives.
    const { tracker, onSingleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    vi.advanceTimersByTime(TAP_WINDOW_MS); // single delivered
    expect(onSingleTap).toHaveBeenCalledTimes(1);
    // Well past CLICK_SUPPRESS_MS (600) but inside the budget:
    vi.advanceTimersByTime(400); // total 900ms since touchend
    expect(tracker.absorbClick({})).toBe(false); // absorbed, not handled
    // Budget exhausted — a further bare click is real.
    expect(tracker.absorbClick({})).toBe(true);
  });

  it("a double-tap banks two budget units and absorbs exactly its two clicks", () => {
    const { tracker, onDoubleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    vi.advanceTimersByTime(150);
    tracker.onTouchStart(gesture([at(103, 104)]));
    tracker.onTouchEnd(gesture([], [at(103, 104)]));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(700); // past any time window
    expect(tracker.absorbClick({})).toBe(false);
    expect(tracker.absorbClick({})).toBe(false);
    expect(tracker.absorbClick({})).toBe(true);
  });

  it("the budget expires so a never-fired click can't eat a later real one", () => {
    const { tracker } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    vi.advanceTimersByTime(2000 + 1); // CLICK_BUDGET_MS
    expect(tracker.absorbClick({})).toBe(true);
  });

  it("a desktop mouse click bypasses the budget", () => {
    const { tracker } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    vi.advanceTimersByTime(TAP_WINDOW_MS);
    expect(tracker.absorbClick({ pointerType: "mouse" })).toBe(true);
  });

  it("a second tap outside the slop is two singles, not a double", () => {
    const { tracker, onSingleTap, onDoubleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    tracker.onTouchStart(gesture([at(160, 100)]));
    tracker.onTouchEnd(gesture([], [at(160, 100)]));
    expect(onDoubleTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TAP_WINDOW_MS * 2);
    expect(onSingleTap).toHaveBeenCalledTimes(2);
  });

  it("a second tap after the window is two singles", () => {
    const { tracker, onSingleTap, onDoubleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    vi.advanceTimersByTime(TAP_WINDOW_MS + 1);
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    expect(onDoubleTap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TAP_WINDOW_MS);
    expect(onSingleTap).toHaveBeenCalledTimes(2);
  });

  it("movement beyond the slop cancels the tap (slider swipe / scroll)", () => {
    const { tracker, onSingleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchMove(gesture([at(120, 100)]));
    tracker.onTouchEnd(gesture([], [at(120, 100)]));
    vi.advanceTimersByTime(TAP_WINDOW_MS * 2);
    expect(onSingleTap).not.toHaveBeenCalled();
  });

  it("touches starting on interactive children never fire", () => {
    const { tracker, onSingleTap, onDoubleTap } = makeTracker({
      isIgnored: () => true,
    });
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    vi.advanceTimersByTime(TAP_WINDOW_MS * 2);
    expect(onSingleTap).not.toHaveBeenCalled();
    expect(onDoubleTap).not.toHaveBeenCalled();
    // The control's own synthetic click must still reach it.
    expect(tracker.absorbClick()).toBe(true);
  });

  it("absorbs the synthetic click after a touch tap, then expires", () => {
    const { tracker } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    expect(tracker.absorbClick()).toBe(false);
    vi.advanceTimersByTime(CLICK_SUPPRESS_MS + 1);
    expect(tracker.absorbClick()).toBe(true);
  });

  it("a real mouse click bypasses the touch suppression window", () => {
    const { tracker } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    // Right after a pinch/tap: mouse input must still work immediately.
    expect(tracker.absorbClick({ pointerType: "mouse" })).toBe(true);
    // The touch-synthesized click is the one we eat.
    expect(tracker.absorbClick({ pointerType: "touch" })).toBe(false);
  });

  it("cancelPending drops a deferred single tap (feed scroll)", () => {
    const { tracker, onSingleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    tracker.cancelPending();
    vi.advanceTimersByTime(TAP_WINDOW_MS * 2);
    expect(onSingleTap).not.toHaveBeenCalled();
  });

  it("a multi-finger touch cancels a pending single tap", () => {
    const { tracker, onSingleTap } = makeTracker();
    tracker.onTouchStart(gesture([at(100, 100)]));
    tracker.onTouchEnd(gesture([], [at(100, 100)]));
    tracker.onTouchStart(gesture([at(100, 100), at(200, 100)]));
    vi.advanceTimersByTime(TAP_WINDOW_MS * 2);
    expect(onSingleTap).not.toHaveBeenCalled();
  });
});

describe("createPinchDetector", () => {
  function makePinch(overrides: Partial<Parameters<typeof createPinchDetector>[0]> = {}) {
    const onPinch = vi.fn();
    const detector = createPinchDetector({ onPinch, ...overrides });
    return { detector, onPinch };
  }

  it("spread beyond the threshold reports immersive on", () => {
    const { detector, onPinch } = makePinch();
    detector.onTouchStart(gesture([at(150), at(250)])); // 100 apart
    detector.onTouchMove(gesture([at(0), at(400)])); // 400 apart
    expect(onPinch).toHaveBeenCalledWith(true);
  });

  it("contraction below the threshold reports immersive off", () => {
    const { detector, onPinch } = makePinch();
    detector.onTouchStart(gesture([at(0), at(400)])); // 400 apart
    detector.onTouchMove(gesture([at(150), at(250)])); // 100 apart
    expect(onPinch).toHaveBeenCalledWith(false);
  });

  it("movement under the threshold fires nothing", () => {
    const { detector, onPinch } = makePinch();
    detector.onTouchStart(gesture([at(150), at(250)]));
    detector.onTouchMove(gesture([at(130), at(270)])); // 140 apart, +40
    expect(onPinch).not.toHaveBeenCalled();
  });

  it("uses the configured threshold", () => {
    const { detector, onPinch } = makePinch({ thresholdPx: 200 });
    detector.onTouchStart(gesture([at(150), at(250)])); // 100
    detector.onTouchMove(gesture([at(120), at(280)])); // 160, +60 < 200
    expect(onPinch).not.toHaveBeenCalled();
    detector.onTouchMove(gesture([at(0), at(400)])); // +300
    expect(onPinch).toHaveBeenCalledWith(true);
  });

  it("pinches starting on interactive children never fire", () => {
    const { detector, onPinch } = makePinch({ isIgnored: () => true });
    detector.onTouchStart(gesture([at(150), at(250)]));
    detector.onTouchMove(gesture([at(0), at(400)]));
    expect(onPinch).not.toHaveBeenCalled();
  });

  it("always preventDefaults 2-finger touchmove (kills native pinch-zoom)", () => {
    const { detector } = makePinch({ isIgnored: () => true });
    detector.onTouchStart(gesture([at(150), at(250)]));
    const move = gesture([at(0), at(400)]);
    detector.onTouchMove(move);
    expect(move.preventDefault).toHaveBeenCalled();
  });

  it("preventDefaults the 2-finger touchstart but never a 1-finger one", () => {
    // iOS Safari commits to native pinch-zoom on the second finger's
    // touchstart; preventDefault there is the only block. The 1-finger
    // touchstart must stay unprevented so feed scroll + slider swipes
    // remain native.
    const { detector } = makePinch();
    const twoFinger = gesture([at(150), at(250)]);
    detector.onTouchStart(twoFinger);
    expect(twoFinger.preventDefault).toHaveBeenCalled();

    const oneFinger = gesture([at(150)]);
    detector.onTouchStart(oneFinger);
    expect(oneFinger.preventDefault).not.toHaveBeenCalled();
  });

  it("touchend resets so the next gesture can fire again", () => {
    const { detector, onPinch } = makePinch();
    detector.onTouchStart(gesture([at(150), at(250)]));
    detector.onTouchMove(gesture([at(0), at(400)]));
    detector.onTouchEnd(gesture([], [at(0), at(400)]));
    expect(onPinch).toHaveBeenCalledTimes(1);

    // A fresh pinch-in gesture must fire false, not be swallowed by
    // stale fired-state from the previous pinch.
    detector.onTouchStart(gesture([at(0), at(400)]));
    detector.onTouchMove(gesture([at(150), at(250)]));
    expect(onPinch).toHaveBeenLastCalledWith(false);
  });

  it("ignores a third finger", () => {
    const { detector, onPinch } = makePinch();
    detector.onTouchStart(gesture([at(150), at(250), at(200)]));
    detector.onTouchMove(gesture([at(0), at(400), at(200)]));
    expect(onPinch).not.toHaveBeenCalled();
  });

  it("exports a sensible default threshold band (60–80px)", () => {
    expect(PINCH_THRESHOLD_PX).toBeGreaterThanOrEqual(60);
    expect(PINCH_THRESHOLD_PX).toBeLessThanOrEqual(80);
  });
});
