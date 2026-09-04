import { createSignal, type Accessor, type Setter } from "solid-js";
import { reportApiError } from "./api/client";
import {
  setBlockedTags as persistBlockedTags,
  setImageSize as persistImageSize,
  setFeedViewMode as persistFeedViewMode,
  setArtistViewMode as persistArtistViewMode,
} from "./api/prefs";

/**
 * Shared bookmark state keyed by illust id. The same work can be mounted
 * in several places at once — main feed, related-view stack anchors,
 * deeper stack levels, the recs modal — and each was keeping its OWN
 * local `liked` signal, so liking in a stack didn't reflect on the main
 * feed card (and vice versa). Every FeedCard reads/writes through here.
 *
 * Truth model: web feeds (street/search) NEVER carry per-work bookmark
 * state — the raw street response has no bookmarkData field at all — so
 * hearts are seeded from pixiv's own bookmarks endpoint (App fetches
 * /api/bookmarks/ids on mount and calls seedLikedIds). The seeded set is
 * reactive: hearts already on screen update when the seed lands. Like /
 * unlike update the set optimistically (the POST is authoritative
 * server-side; on failure the caller's error path re-syncs).
 */
const likeStates = new Map<
  number,
  { liked: Accessor<boolean>; setLiked: Setter<boolean> }
>();

// Cap: one signal + closure per illust id, never evicted outside tests.
// A long mobile session scrolls through hundreds of works; on iOS's
// memory budget the map must not grow unbounded (reviewer finding).
// Oldest-evict past the cap — Map iterates in insertion order.
const maxLikeStateEntries = 1024;

const [likedIds, setLikedIds] = createSignal<ReadonlySet<number>>(
  new Set<number>()
);

export function getLikeState(id: number, initial: boolean) {
  let entry = likeStates.get(id);
  if (!entry) {
    // The per-id signal holds the pre-seed state; the accessor merges it
    // with the seeded set so seedLikedIds() re-renders hearts.
    const [local, setLocal] = createSignal(initial);
    const liked = () => local() || likedIds().has(id);
    const setLiked: Setter<boolean> = (v) => {
      const next =
        typeof v === "function" ? (v as (p: boolean) => boolean)(liked()) : v;
      setLikedIds((prev) => {
        const n = new Set(prev);
        if (next) n.add(id);
        else n.delete(id);
        return n;
      });
      return setLocal(next);
    };
    entry = { liked, setLiked };
    likeStates.set(id, entry);
    while (likeStates.size > maxLikeStateEntries) {
      const oldest = likeStates.keys().next().value;
      if (oldest === undefined) break;
      likeStates.delete(oldest);
    }
  }
  return entry;
}

/**
 * Seeds hearts from pixiv's bookmarks endpoint (server truth). REPLACES
 * the whole set — reviewer finding: the old version only ADDED ids, so a
 * work unliked on pixiv.com kept showing a filled heart after a resync
 * (the stale id never left the set). Server truth means the server's
 * list wins, empty included.
 */
export function seedLikedIds(ids: number[]) {
  setLikedIds(new Set(ids));
}

/** Test hook — reset between unit tests so state can't leak across them. */
export function clearLikeStates() {
  likeStates.clear();
  setLikedIds(new Set<number>());
}

// ── Blocked tag filter (Pixiv gates this behind premium — do it locally) ──

// The list lives in the backend prefs DB (GET on mount, PUT on change).
// The in-memory signal is the working copy; backend failures degrade to
// session-only filtering.
const [blockedTags, setBlockedTagsRaw] = createSignal<string[]>([]);

/** Replaces the working list (used by App's initial fetch). */
export function setBlockedTagsList(tags: string[]) {
  setBlockedTagsRaw(tags);
}

function updateBlockedTags(updater: (prev: string[]) => string[]): string[] {
  let next: string[] = [];
  setBlockedTagsRaw((prev) => {
    next = updater(prev);
    return next;
  });
  void persistBlockedTags(next).catch(reportApiError);
  return next;
}

export function addBlockedTag(tag: string) {
  const t = tag.trim().toLowerCase();
  if (!t) return;
  updateBlockedTags((prev) => (prev.includes(t) ? prev : [...prev, t]));
}

export function removeBlockedTag(tag: string) {
  updateBlockedTags((prev) => prev.filter((t) => t !== tag.toLowerCase()));
}

/** Test hook — reset between unit tests so state can't leak across them. */
export function clearBlockedTags() {
  setBlockedTagsRaw([]);
}

// ── Image quality (data saver) ─────────────────────────────────────────

// "large" (master1200) or "medium" (540 where the feed carries it —
// street + app-API feeds do; web square-thumbs fall back to large).
const [imageSize, setImageSizeRaw] = createSignal<"large" | "medium">("large");

/** Applies the value loaded from the server (no PUT round-trip). */
export function setImageSizeFromServer(v: "large" | "medium") {
  if (v === "medium") setImageSizeRaw("medium");
  else setImageSizeRaw("large");
}

/** User action: update locally + persist to the prefs DB. */
export function setImageSize(v: "large" | "medium") {
  setImageSizeRaw(v);
  void persistImageSize(v).catch(reportApiError);
}

/** Test hook. */
export function clearImageSize() {
  setImageSizeRaw("large");
}

export { imageSize };

// ── View modes (feeds + artist pages render strip | grid) ──────────────
//
// Global prefs, NOT session state: they live in the backend prefs DB
// like blocked tags + image size, so a reload never needs the snapshot
// to carry them. Strips everywhere by default; the Settings modal has
// one toggle row for feed tabs and one for artist pages.

export type ViewMode = "strip" | "grid";

const [feedViewMode, setFeedViewModeRaw] = createSignal<ViewMode>("strip");

/** Applies the value loaded from the server (no PUT round-trip). */
export function setFeedViewModeFromServer(v: string) {
  setFeedViewModeRaw(v === "grid" ? "grid" : "strip");
}

/** User action: update locally + persist to the prefs DB. */
export function setFeedViewMode(v: ViewMode) {
  setFeedViewModeRaw(v);
  void persistFeedViewMode(v).catch(reportApiError);
}

/** Test hook. */
export function clearFeedViewMode() {
  setFeedViewModeRaw("strip");
}

const [artistViewMode, setArtistViewModeRaw] = createSignal<ViewMode>("strip");

/** Applies the value loaded from the server (no PUT round-trip). */
export function setArtistViewModeFromServer(v: string) {
  setArtistViewModeRaw(v === "grid" ? "grid" : "strip");
}

/** User action: update locally + persist to the prefs DB. */
export function setArtistViewMode(v: ViewMode) {
  setArtistViewModeRaw(v);
  void persistArtistViewMode(v).catch(reportApiError);
}

/** Test hook. */
export function clearArtistViewMode() {
  setArtistViewModeRaw("strip");
}

export { feedViewMode, artistViewMode };

// ── One-time stack hint ("Related works — ← Back returns") ──────────────

const HINT_KEY = "pixtok_stack_hint_dismissed";

const [stackHintDismissed, setStackHintDismissedRaw] = createSignal<boolean>(
  (() => {
    try {
      return localStorage.getItem(HINT_KEY) === "1";
    } catch {
      return false;
    }
  })()
);

export function dismissStackHint() {
  setStackHintDismissedRaw(true);
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    // private-mode localStorage can throw — hint just shows again
  }
}

/** Test hook. */
export function clearStackHint() {
  setStackHintDismissedRaw(false);
}

export { stackHintDismissed, blockedTags };
