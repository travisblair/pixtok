// Pure feed-window helpers — extracted from FeedCard so the preload/unload
// math is unit-testable without SolidJS or IntersectionObserver.

import type { PixivIllust } from "./types";

export const PRELOAD_PAGES = 2;

/** Sliders with more pages than this get a tighter load window. */
export const LARGE_SLIDER_PAGES = 10;

/**
 * Load window for a slider: normal sliders preload ±PRELOAD_PAGES around
 * the current page; big sliders (manga with dozens of pages) keep a ±1
 * window so decoded master1200 bitmaps stay bounded on iOS — a 120-page
 * work must never hold more than ~3 pages in memory at once.
 */
export function sliderWindowSize(totalPages: number): number {
  return totalPages > LARGE_SLIDER_PAGES ? 1 : PRELOAD_PAGES;
}

/**
 * Filters out items whose id is already in `seen`, registering new ids.
 * Pixiv's personalized feeds deliberately re-inject works across pages
 * (the street cursor carries the overlap), so every append goes through
 * this to keep the feed duplicate-free. Mutates `seen`; returns only the
 * fresh items.
 */
export function dedupeSeen(
  seen: Set<number>,
  items: PixivIllust[]
): PixivIllust[] {
  return items.filter((i) => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
}

/**
 * Normalize an illust's tags to a string list. Feeds disagree on the
 * shape: web transforms emit {name, translated_name?}[], the app-API
 * passthroughs emit {name, translated_name}[], and (historically) some
 * web payloads carried plain strings. Case-insensitive names.
 */
export function normalizeTags(illust: PixivIllust): string[] {
  const tags = (illust as PixivIllust & { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string") {
        return (t as { name: string }).name;
      }
      return null;
    })
    .filter((t): t is string => t !== null);
}

export interface TagPair {
  name: string;
  translated?: string; // Pixiv's translated_name, when present AND different
}

/**
 * Tag names WITH their translations (Pixiv serves {name, translated_name}
 * on both web and app-API shapes). The translation is omitted when it
 * equals the name or is absent/empty — the tag popup shows it as a small
 * second line under the original.
 */
export function normalizeTagPairs(illust: PixivIllust): TagPair[] {
  const tags = (illust as PixivIllust & { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return [];
  return tags.flatMap((t) => {
    if (typeof t === "string") return [{ name: t }];
    if (!t || typeof t !== "object") return [];
    const name = (t as { name?: unknown }).name;
    if (typeof name !== "string") return [];
    const tr = (t as { translated_name?: unknown }).translated_name;
    if (typeof tr === "string" && tr.trim() !== "" && tr !== name) {
      return [{ name, translated: tr }];
    }
    return [{ name }];
  });
}

/**
 * Filter out works carrying any blocked tag (case-insensitive substring
 * match — "swimsuit" should also catch "summer swimsuit" and "swimsuit pose").
 */
export function filterBlockedTags(
  items: PixivIllust[],
  blocked: readonly string[]
): PixivIllust[] {
  if (blocked.length === 0) return items;
  return items.filter((ill) => {
    const tags = normalizeTags(ill);
    return !tags.some((t) =>
      blocked.some((b) => t.toLowerCase().includes(b))
    );
  });
}

/**
 * Whether a slider page should have its real image src (vs the 1px
 * placeholder). Pages outside the ±window around the current page are
 * not loaded even when the card is active.
 */
/**
 * Load-window bounds for a slider, spanning the live page AND the
 * settled page. During a swipe the two disagree — iOS scroll-snap fires
 * its last scroll event mid-snap, with a rounded index that doesn't
 * match the resting page. Spanning both keeps boundary pages from
 * flapping their src between the proxy URL and the 1px placeholder;
 * iOS aborts in-flight decodes on src swaps and sometimes never
 * restarts them (the black-page bug). Once the swipe settles, live ===
 * settled and the span collapses to the normal ±window.
 */
export function sliderWindowBounds(
  livePage: number,
  settledPage: number,
  windowSize: number
): [number, number] {
  const lo = Math.min(livePage, settledPage) - windowSize;
  const hi = Math.max(livePage, settledPage) + windowSize;
  return [lo, hi];
}

export function shouldLoadPage(args: {
  active: boolean;
  currentPage: number;
  pageIndex: number;
  windowSize?: number;
}): boolean {
  const w = args.windowSize ?? PRELOAD_PAGES;
  return args.active && Math.abs(args.pageIndex - args.currentPage) <= w;
}

/**
 * Distance-prioritized activation delay: visible cards load immediately,
 * cards deeper in the N-viewport window wait proportionally (up to
 * maxViewports × msPerViewport ms). Spreads image-load bursts from bulk
 * content insertion (e.g. recommendations) so near images get bandwidth
 * first and far images trickle in behind.
 */
export function computeLoadDelay(args: {
  distPx: number;
  viewportPx: number;
  maxViewports?: number;
  msPerViewport?: number;
}): number {
  const maxV = args.maxViewports ?? 6;
  const ms = args.msPerViewport ?? 100;
  if (args.viewportPx <= 0 || args.distPx <= 0) return 0;
  const viewports = Math.min(args.distPx / args.viewportPx, maxV);
  return Math.round(viewports * ms);
}
