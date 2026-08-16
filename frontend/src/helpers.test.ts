import { describe, it, expect } from "vitest";
import {
  shouldLoadPage,
  computeLoadDelay,
  dedupeSeen,
  normalizeTags,
  normalizeTagPairs,
  filterBlockedTags,
  sliderWindowSize,
  sliderWindowBounds,
  PRELOAD_PAGES,
  LARGE_SLIDER_PAGES,
} from "./helpers";
import type { PixivIllust } from "./types";
import { makeIllust } from "./test-fixtures";

describe("normalizeTags", () => {
  const ill = (tags: unknown): PixivIllust => makeIllust({ tags } as never);

  it("handles object tags (web + app shapes)", () => {
    expect(
      normalizeTags(ill([{ name: "swimsuit" }, { name: "cute", translated_name: "x" }]))
    ).toEqual(["swimsuit", "cute"]);
  });

  it("handles plain string tags", () => {
    expect(normalizeTags(ill(["swimsuit", "cute"]))).toEqual(["swimsuit", "cute"]);
  });

  it("handles missing/garbage tags", () => {
    expect(normalizeTags(makeIllust({}))).toEqual([]);
    expect(normalizeTags(ill([42, null, "ok"]))).toEqual(["ok"]);
  });
});

describe("normalizeTagPairs", () => {
  const ill = (tags: unknown): PixivIllust => makeIllust({ tags } as never);

  it("carries the translated_name alongside the name", () => {
    expect(
      normalizeTagPairs(
        ill([
          { name: "水着", translated_name: "Swimsuit" },
          { name: "オリジナル" },
        ])
      )
    ).toEqual([
      { name: "水着", translated: "Swimsuit" },
      { name: "オリジナル" },
    ]);
  });

  it("drops translations that are empty or identical to the name", () => {
    expect(
      normalizeTagPairs(ill([{ name: "夏", translated_name: "" }, { name: "cute", translated_name: "cute" }]))
    ).toEqual([{ name: "夏" }, { name: "cute" }]);
  });

  it("handles plain string tags and garbage", () => {
    expect(normalizeTagPairs(ill(["pixiv", 42, null]))).toEqual([{ name: "pixiv" }]);
    expect(normalizeTagPairs(makeIllust({}))).toEqual([]);
  });
});

describe("filterBlockedTags", () => {
  const ill = (id: number, tags: { name: string }[]): PixivIllust =>
    makeIllust({ id, tags });

  it("passes everything through with no blocked tags", () => {
    const items = [ill(1, [{ name: "swimsuit" }]), ill(2, [{ name: "cute" }])];
    expect(filterBlockedTags(items, [])).toEqual(items);
  });

  it("drops works with an exact blocked tag", () => {
    const items = [ill(1, [{ name: "swimsuit" }]), ill(2, [{ name: "cute" }])];
    expect(filterBlockedTags(items, ["swimsuit"]).map((i) => i.id)).toEqual([2]);
  });

  it("substring-matches — 'swimsuit' also catches 'summer swimsuit'", () => {
    const items = [ill(1, [{ name: "summer swimsuit" }]), ill(2, [{ name: "cute" }])];
    expect(filterBlockedTags(items, ["swimsuit"]).map((i) => i.id)).toEqual([2]);
  });

  it("is case-insensitive", () => {
    const items = [ill(1, [{ name: "Swimsuit" }])];
    expect(filterBlockedTags(items, ["swimsuit"])).toEqual([]);
  });
});

describe("dedupeSeen", () => {
  const ill = (id: number): PixivIllust => makeIllust({ id });

  it("returns all items on first sight", () => {
    const seen = new Set<number>();
    const out = dedupeSeen(seen, [ill(1), ill(2), ill(3)]);
    expect(out.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(seen).toEqual(new Set([1, 2, 3]));
  });

  it("filters items already seen on previous pages", () => {
    const seen = new Set<number>([1, 2]);
    const out = dedupeSeen(seen, [ill(2), ill(3), ill(4)]);
    expect(out.map((i) => i.id)).toEqual([3, 4]);
    expect(seen.has(3)).toBe(true);
  });

  it("drops duplicates WITHIN the incoming batch", () => {
    const seen = new Set<number>();
    const out = dedupeSeen(seen, [ill(5), ill(5), ill(6)]);
    expect(out.map((i) => i.id)).toEqual([5, 6]);
  });

  it("returns empty and registers nothing for an empty batch", () => {
    const seen = new Set<number>();
    expect(dedupeSeen(seen, [])).toEqual([]);
    expect(seen.size).toBe(0);
  });
});

describe("shouldLoadPage", () => {
  it("loads nothing when inactive", () => {
    expect(
      shouldLoadPage({ active: false, currentPage: 0, pageIndex: 0 })
    ).toBe(false);
  });

  it("loads the current page and ±window neighbours", () => {
    const base = { active: true, currentPage: 5 };
    expect(shouldLoadPage({ ...base, pageIndex: 5 })).toBe(true);
    expect(shouldLoadPage({ ...base, pageIndex: 3 })).toBe(true);
    expect(shouldLoadPage({ ...base, pageIndex: 7 })).toBe(true);
    expect(shouldLoadPage({ ...base, pageIndex: 2 })).toBe(false);
    expect(shouldLoadPage({ ...base, pageIndex: 8 })).toBe(false);
  });

  it("honours a custom window size", () => {
    expect(
      shouldLoadPage({ active: true, currentPage: 10, pageIndex: 10, windowSize: 0 })
    ).toBe(true);
    expect(
      shouldLoadPage({ active: true, currentPage: 10, pageIndex: 11, windowSize: 0 })
    ).toBe(false);
  });
});

describe("sliderWindowSize", () => {
  it("uses the standard preload window for small sliders", () => {
    expect(sliderWindowSize(1)).toBe(PRELOAD_PAGES);
    expect(sliderWindowSize(10)).toBe(PRELOAD_PAGES);
  });

  it("tightens to ±1 once the slider passes the large threshold", () => {
    expect(sliderWindowSize(LARGE_SLIDER_PAGES + 1)).toBe(1);
    expect(sliderWindowSize(120)).toBe(1);
  });
});

describe("computeLoadDelay", () => {
  it("visible cards load immediately", () => {
    expect(computeLoadDelay({ distPx: 0, viewportPx: 800 })).toBe(0);
    expect(computeLoadDelay({ distPx: -50, viewportPx: 800 })).toBe(0);
  });

  it("scales with distance: 100ms per viewport", () => {
    expect(computeLoadDelay({ distPx: 800, viewportPx: 800 })).toBe(100);
    expect(computeLoadDelay({ distPx: 2400, viewportPx: 800 })).toBe(300);
  });

  it("caps at maxViewports x msPerViewport", () => {
    expect(computeLoadDelay({ distPx: 10000, viewportPx: 800 })).toBe(600);
    expect(
      computeLoadDelay({ distPx: 10000, viewportPx: 800, maxViewports: 3, msPerViewport: 50 })
    ).toBe(150);
  });

  it("handles zero viewport defensively", () => {
    expect(computeLoadDelay({ distPx: 100, viewportPx: 0 })).toBe(0);
  });
});

describe("sliderWindowBounds", () => {
  it("collapses to the normal ±window once live and settled agree", () => {
    expect(sliderWindowBounds(5, 5, 2)).toEqual([3, 7]);
    expect(sliderWindowBounds(0, 0, 1)).toEqual([-1, 1]);
  });

  it("spans live and settled mid-swipe so boundary pages don't flap", () => {
    // Last scroll event rounded to page 2 while the snap is carrying the
    // slider to page 3: pages 1-6 stay in the window until it settles.
    expect(sliderWindowBounds(2, 3, 1)).toEqual([1, 4]);
    // Wide disagreement (long fling): the whole span stays alive
    // transiently; it collapses back after the settle commits.
    expect(sliderWindowBounds(1, 8, 1)).toEqual([0, 9]);
  });

  it("treats a backwards swipe symmetrically", () => {
    expect(sliderWindowBounds(6, 4, 1)).toEqual([3, 7]);
  });
});
