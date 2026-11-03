import { createSignal, type Accessor, type Setter } from "solid-js";
import { reportApiError } from "./api/client";
import {
  setBlockedTags as persistBlockedTags,
  setImageSize as persistImageSize,
  setFeedViewMode as persistFeedViewMode,
  setArtistViewMode as persistArtistViewMode,
  setMaxStackDepth as persistMaxStackDepth,
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

// Local edits made BEFORE the boot seed answered. The seed is server truth
// for everything else, but it is a snapshot of the DB from before those
// edits: replacing the working list with it dropped a just-added block and
// resurrected a just-removed one (the "ghost revert" — the pill vanished
// and the feed reloaded unfiltered). Merge the seed with the edits
// instead; tombstoned removals keep the merge from resurrecting them.
let blockedSeedApplied = false;
const pendingAdds = new Set<string>();
const pendingRemovals = new Set<string>();

function normalizeBlockedTags(tags: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const v = t.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Applies the boot GET /prefs/blocked-tags seed (server truth, merged). */
export function setBlockedTagsList(tags: string[]) {
  const server = normalizeBlockedTags(tags);
  if (blockedSeedApplied) {
    setBlockedTagsRaw(server);
    return;
  }
  blockedSeedApplied = true;
  const edited = pendingAdds.size > 0 || pendingRemovals.size > 0;
  let merged = server;
  if (edited) {
    const set = new Set([...server, ...blockedTags(), ...pendingAdds]);
    for (const t of pendingRemovals) set.delete(t);
    merged = [...set];
  }
  setBlockedTagsRaw(merged);
  pendingAdds.clear();
  pendingRemovals.clear();
  // The edit's own PUT carried only the pre-seed working list, so it may
  // have dropped tags the seed still had. Write the merged truth back.
  if (edited) void persistBlockedTags(merged).catch(reportApiError);
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
  if (!blockedSeedApplied) {
    pendingAdds.add(t);
    pendingRemovals.delete(t); // re-added within the window — not a removal
  }
  updateBlockedTags((prev) => (prev.includes(t) ? prev : [...prev, t]));
}

export function removeBlockedTag(tag: string) {
  const t = tag.trim().toLowerCase();
  if (!blockedSeedApplied) {
    pendingRemovals.add(t);
    pendingAdds.delete(t);
  }
  updateBlockedTags((prev) => prev.filter((x) => x !== t));
}

/** Test hook — reset between unit tests so state can't leak across them. */
export function clearBlockedTags() {
  setBlockedTagsRaw([]);
  blockedSeedApplied = false;
  pendingAdds.clear();
  pendingRemovals.clear();
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

// ── Max stack depth (related stack + stacked search pages) ─────────────
//
// ONE setting governs BOTH caps (product decision: "make the stack
// deeper" means every overlay stack, not just the related one). Bounds:
// default 10, 0 (or garbage) means default, hard cap 30. The backend
// normalizes the same way — this side normalizes before sending so the
// UI and the DB never disagree.

export const DEFAULT_MAX_STACK_DEPTH = 10;
export const MAX_STACK_DEPTH_LIMIT = 30;

/** 0 / empty / non-numeric → default; otherwise clamp 1..30. */
export function normalizeMaxStackDepth(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") {
    return DEFAULT_MAX_STACK_DEPTH;
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return DEFAULT_MAX_STACK_DEPTH;
  const i = Math.trunc(n);
  if (i === 0) return DEFAULT_MAX_STACK_DEPTH;
  return Math.min(MAX_STACK_DEPTH_LIMIT, Math.max(1, i));
}

const [maxStackDepth, setMaxStackDepthRaw] = createSignal(
  DEFAULT_MAX_STACK_DEPTH
);

// Did the boot GET land yet? state-persistence reads this to decide
// whether it may truncate a restored snapshot at the live cap or must
// wait and use the hard upper bound (dropping valid layers is worse
// than restoring a few above a lowered cap).
let maxStackDepthLoaded = false;

/** Applies the value loaded from the server (no PUT round-trip). */
export function setMaxStackDepthFromServer(v: unknown) {
  maxStackDepthLoaded = true;
  setMaxStackDepthRaw(normalizeMaxStackDepth(v));
}

/** True once the boot GET answered (or a user change landed). */
export function isMaxStackDepthLoaded() {
  return maxStackDepthLoaded;
}

/** User action: normalize locally + persist to the prefs DB. */
export function setMaxStackDepth(v: number | string) {
  const next = normalizeMaxStackDepth(v);
  maxStackDepthLoaded = true;
  setMaxStackDepthRaw(next);
  void persistMaxStackDepth(next).catch(reportApiError);
}

/** Test hook. */
export function clearMaxStackDepth() {
  maxStackDepthLoaded = false;
  setMaxStackDepthRaw(DEFAULT_MAX_STACK_DEPTH);
}

export { maxStackDepth };

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
