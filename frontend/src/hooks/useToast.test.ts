import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { useToast } from "./useToast";

describe("useToast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeToast() {
    let api!: ReturnType<typeof useToast>;
    const dispose = createRoot((d) => {
      api = useToast();
      return d;
    });
    return { api, dispose };
  }

  it("a normal toast auto-hides after 8s", () => {
    const { api } = makeToast();
    api.show("hello");
    expect(api.visible()).toBe(true);
    vi.advanceTimersByTime(7999);
    expect(api.visible()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(api.visible()).toBe(false);
  });

  it("a sticky toast never auto-hides (bookmark-move completion)", () => {
    const { api } = makeToast();
    api.show("Moved 40 works to private", false, true);
    expect(api.visible()).toBe(true);
    expect(api.opens()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(api.visible()).toBe(true);

    // hide() still dismisses it on demand.
    api.hide();
    expect(api.visible()).toBe(false);
  });

  it("a sticky toast followed by a normal toast re-arms the timer", () => {
    const { api } = makeToast();
    api.show("sticky", false, true);
    vi.advanceTimersByTime(20_000);
    expect(api.visible()).toBe(true);

    api.show("transient", false);
    expect(api.visible()).toBe(true);
    vi.advanceTimersByTime(8000);
    expect(api.visible()).toBe(false);
  });
});
