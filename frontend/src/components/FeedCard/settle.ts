// Slider settle detector — extracted from FeedCard. iOS momentum +
// scroll-snap can fire the last scroll event MID-snap with a rounded
// index that doesn't match the resting page, and no further event fires
// once the snap lands. The detector polls scrollLeft until it's still,
// then commits the true page; the card's load window follows the
// settled page.

/** Poll cadence while (and after) the snap/momentum animation runs. */
const SETTLE_POLL_MS = 120;
/** Two reads closer than this delta count as "still" (sub-pixel drift). */
const SETTLE_EPSILON_PX = 2;

interface SettleDetectorOptions {
  /** The horizontal slider; undefined before mount. */
  getElement: () => HTMLElement | undefined;
  /** Live page while the user scrolls (rAF-throttled). */
  onPage: (index: number) => void;
  /** The at-rest page, once two polls agree. */
  onSettle: (index: number) => void;
}

export function createSettleDetector(opts: SettleDetectorOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRead: number | undefined;
  let raf = 0; // rAF handle for the onScroll throttle

  function check() {
    const el = opts.getElement();
    if (!el) return;
    const left = el.scrollLeft;
    const idx = Math.round(left / el.clientWidth);
    if (lastRead !== undefined && Math.abs(left - lastRead) < SETTLE_EPSILON_PX) {
      // At rest (or the snap finished): commit the true resting page.
      opts.onSettle(idx);
      lastRead = undefined;
      return;
    }
    lastRead = left;
    timer = setTimeout(check, SETTLE_POLL_MS);
  }

  function onScroll() {
    if (!opts.getElement()) return;
    // Re-arm the settle detector. While the snap/momentum animation is
    // still moving scrollLeft, keep polling; when two reads agree, the
    // slider is at rest and THAT page owns the load window.
    clearTimeout(timer);
    lastRead = undefined;
    timer = setTimeout(check, SETTLE_POLL_MS);
    // rAF-throttle the counter update: scroll events can fire several
    // times per frame mid-gesture, and each one used to re-render the
    // whole slider. One update per frame is all the eye can see.
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const slider = opts.getElement();
      if (!slider) return;
      opts.onPage(Math.round(slider.scrollLeft / slider.clientWidth));
    });
  }

  function dispose() {
    clearTimeout(timer);
  }

  return { onScroll, dispose };
}
