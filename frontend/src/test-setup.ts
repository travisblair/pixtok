import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";
import {
  clearLikeStates,
  clearBlockedTags,
  clearStackHint,
  clearImageSize,
  clearFeedViewMode,
  clearArtistViewMode,
} from "./store";

afterEach(() => {
  cleanup();
  // Shared stores are module-global — reset so state can't leak between
  // unit tests.
  clearLikeStates();
  clearBlockedTags();
  clearStackHint();
  clearImageSize();
  clearFeedViewMode();
  clearArtistViewMode();
});

// jsdom has no IntersectionObserver — mock it with an implementation that
// reports every observed element as intersecting (active immediately).
// Tests that need inactive cards can swap the mock per-test via vi.stubGlobal.
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: (entries: IntersectionObserverEntry[]) => void;

  constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe(el: Element) {
    const rect = el.getBoundingClientRect();
    const rootBounds = {
      top: 0,
      bottom: 800,
      height: 800,
      left: 0,
      right: 1200,
      width: 1200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    this.callback([
      {
        isIntersecting: true,
        boundingClientRect: rect,
        rootBounds,
        intersectionRatio: 1,
        intersectionRect: rect,
        target: el,
        time: Date.now(),
      } as unknown as IntersectionObserverEntry,
    ]);
  }

  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

globalThis.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver;

// jsdom lacks ResizeObserver too; components don't use it today but a
// future dependency might.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  MockResizeObserver as unknown as typeof ResizeObserver;
