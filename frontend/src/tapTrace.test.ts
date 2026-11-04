import { describe, it, expect, vi, afterEach } from "vitest";
import { summarizeTarget, installTapTrace } from "./tapTrace";

/** Minimal element stand-in with the two members summarizeTarget reads. */
function el(tag: string, cls: string, related = false): HTMLElement {
  const node = {
    tagName: tag,
    className: cls,
    closest: vi.fn((sel: string) =>
      sel === ".related-view" && related ? {} : null
    ),
  };
  return node as unknown as HTMLElement;
}

describe("summarizeTarget", () => {
  it("names tag + top classes", () => {
    expect(summarizeTarget(el("DIV", "feed-card card-1 immersive"))).toBe(
      "DIV.feed-card.card-1"
    );
  });

  it("marks related-view descendants", () => {
    expect(summarizeTarget(el("DIV", "card-image", true))).toBe(
      "DIV.card-image[rel]"
    );
  });

  it("handles null and class-less targets", () => {
    expect(summarizeTarget(null)).toBe("none");
    expect(summarizeTarget(el("IMG", ""))).toBe("IMG.");
  });
});

describe("installTapTrace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches capture listeners without touching the network", () => {
    const add = vi.spyOn(document, "addEventListener");
    installTapTrace();
    const types = add.mock.calls.map((c) => c[0] as string);
    expect(types).toEqual(
      expect.arrayContaining(["touchstart", "touchend", "click", "touchcancel", "touchmove"])
    );
    // Every listener is passive capture: never blocks scrolling.
    for (const [, , opts] of add.mock.calls) {
      expect(opts).toMatchObject({ capture: true, passive: true });
    }
  });

  it("ignores gestures that do not originate on cards", () => {
    installTapTrace();
    // A touchend without a card-origin touchstart is dropped silently —
    // no breadcrumb, no throw.
    const card = el("DIV", "feed-card");
    const evt = new Event("touchend", { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "target", { value: card });
    expect(() => document.dispatchEvent(evt)).not.toThrow();
  });
});
