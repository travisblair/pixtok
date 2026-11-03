import type { PixivIllust, SearchUserResult } from "./types";
import type { SearchState } from "./components/SearchScreen";
import { DEFAULT_FILTERS } from "./components/SearchFilters";

// Feed-tab membership for snapshot validation (mirrors the FeedType
// union in App.tsx — a hand-edited or future-schema snapshot must not
// load an unknown tab silently).
const FEED_TYPES = ["home", "newest", "illustrations", "top", "recommended", "bookmarks"];

// Restored stack/recs entries go straight to FeedCard (no refetch), so
// they must carry the shape its render reads unconditionally — a
// user-less entry throws on `props.illust.user.name`, and the throw
// escapes boot() and masquerades as gate:unreachable (boot dies, the
// GateScreen stays up forever). The old id-only guard let `{"id":5}`
// through; require the full render shape instead.
function isRenderableIllustEntry(s: unknown): s is PixivIllust {
  if (!s || typeof s !== "object") return false;
  const entry = s as {
    id?: unknown;
    user?: { id?: unknown; name?: unknown } | null;
    image_urls?: { large?: unknown } | null;
  };
  return (
    typeof entry.id === "number" &&
    !!entry.user &&
    typeof entry.user === "object" &&
    typeof entry.user.id === "number" &&
    typeof entry.user.name === "string" &&
    !!entry.image_urls &&
    typeof entry.image_urls === "object" &&
    typeof entry.image_urls.large === "string"
  );
}

/**
 * Search layers restore their result arrays straight into SearchScreen,
 * which reads `w.id` for its dedupe set and `u.previews.slice(...)` in the
 * artist rows. Validating only the CONTAINERS let a null work or a
 * user without previews through, and the throw escaped boot(): the gate
 * catch re-locked the screen (reported as gate:unreachable) with no way to
 * repair the saved state. Sanitize the entries; a layer whose contents are
 * bad restores EMPTY and its mount auto-run refetches.
 */
function sanitizeSearchUser(v: unknown): SearchUserResult | null {
  if (!v || typeof v !== "object") return null;
  const u = v as {
    id?: unknown;
    name?: unknown;
    avatar?: unknown;
    premium?: unknown;
    is_followed?: unknown;
    previews?: unknown;
  };
  if (
    typeof u.id !== "number" ||
    typeof u.name !== "string" ||
    typeof u.avatar !== "string"
  ) {
    return null;
  }
  return {
    id: u.id,
    name: u.name,
    avatar: u.avatar,
    premium: u.premium === true,
    is_followed: u.is_followed === true,
    previews: Array.isArray(u.previews)
      ? u.previews.filter(isRenderableIllustEntry)
      : [],
  };
}

function sanitizeRelatedTag(
  v: unknown
): { name: string; translated_name?: string } | null {
  if (!v || typeof v !== "object") return null;
  const t = v as { name?: unknown; translated_name?: unknown };
  if (typeof t.name !== "string") return null;
  return typeof t.translated_name === "string"
    ? { name: t.name, translated_name: t.translated_name }
    : { name: t.name };
}

function sanitizeSearchState(v: unknown): SearchState | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  // Containers required; anything else falls back to the filter defaults.
  if (
    typeof s.word !== "string" ||
    !Array.isArray(s.works) ||
    !Array.isArray(s.users)
  ) {
    return null;
  }
  return {
    word: s.word,
    mode: s.mode === "artists" ? "artists" : "works",
    order: typeof s.order === "string" ? s.order : DEFAULT_FILTERS.order,
    contentMode:
      s.contentMode === "safe" || s.contentMode === "r18"
        ? s.contentMode
        : DEFAULT_FILTERS.contentMode,
    workType:
      s.workType === "illust" || s.workType === "ugoira"
        ? s.workType
        : DEFAULT_FILTERS.workType,
    sMode: typeof s.sMode === "string" ? s.sMode : DEFAULT_FILTERS.sMode,
    aiType: s.aiType === "1" ? "1" : DEFAULT_FILTERS.aiType,
    dateMode: s.dateMode === "custom" ? "custom" : "all",
    scd: typeof s.scd === "string" ? s.scd : "",
    sce: typeof s.sce === "string" ? s.sce : "",
    works: s.works.filter(isRenderableIllustEntry),
    popular: Array.isArray(s.popular)
      ? s.popular.filter(isRenderableIllustEntry)
      : [],
    related: Array.isArray(s.related)
      ? s.related
          .map(sanitizeRelatedTag)
          .filter((t): t is { name: string } => t !== null)
      : [],
    users: s.users
      .map(sanitizeSearchUser)
      .filter((u): u is SearchUserResult => u !== null),
    page:
      typeof s.page === "number" && Number.isInteger(s.page) && s.page >= 0
        ? s.page
        : 0,
    hasMore: s.hasMore === true,
  };
}

/**
 * Reload-safe LAYER state: survives iOS jetsam kills (localStorage, not
 * sessionStorage). Snapshot shape is versioned — old or corrupt payloads
 * load as null and the app starts fresh.
 *
 * Contents (user decision Aug 2026):
 *  - active feed TAB + pill selections (navigation state, not content)
 *  - the related-view stack (anchor works only — each level refetches
 *    its related list on mount)
 *  - the open artist page
 *  - the recs modal (its work list + source title + open flag)
 *  - the search layer
 *
 * Deliberately NOT persisted: the feed itself (illusts, pagination
 * cursor, scroll position). Feeds always load fresh on boot — a
 * restored feed meant days-old content at the top with fresh works only
 * trickling in via scroll pagination, and browsers diverged (STP vs
 * Safari on the same phone showed different feeds). Layers persist,
 * feeds are always new.
 */

const KEY = "pixtok_state_v2";

export const MAX_SNAPSHOT_ITEMS = 100;
// DEFAULT related-stack depth. The LIVE cap is the user pref in store.ts
// (default 10, hard max 30) — useLayers refuses pushes at the live value.
// The snapshot must never clip at this default: a user who raised the cap
// to 30 would silently lose 20 layers on the next save (see MAX_*_HARD).
export const MAX_STACK_DEPTH = 10;
// Default max stacked search pages (tag taps instance new layers). Same
// one-source-of-truth rule as the related stack. Artist pages do NOT
// count against any cap (single replaceable layer).
export const MAX_SEARCH_DEPTH = 10;
// Hard upper bounds the pref is clamped to (store.ts mirrors these).
// Snapshot truncation uses these, never the defaults: a pref that has
// not loaded yet at hydrate time must not drop valid deep layers.
export const MAX_STACK_DEPTH_HARD = 30;
export const MAX_SEARCH_DEPTH_HARD = 30;

export interface AppSnapshot {
  v: 1;
  feedType: string;
  rankContent: string;
  rankMode: string;
  newestR18: boolean;
  topMode: string;
  // Bookmarks tab pill selections (public|private pile + the active tag
  // folder) — navigation state like the tabs above, so a reload lands on
  // the SAME pile instead of snapping back to Public/unfiltered. Absent in
  // pre-fix v1 payloads: those load as public / no tag (the old default).
  bookmarkVis: "public" | "private";
  bookmarkTag: string;
  stack: PixivIllust[];
  artist: { id: number; name: string } | null;
  recs: PixivIllust[];
  recsSource: string;
  modalOpen: boolean;
  // Stacked search layers (2026-09 multi-search): parallel arrays —
  // each layer's SearchState plus the tag it was seeded from (null =
  // free-form drawer search; the tag identity feeds the dedupe rule
  // "a tag already open re-opens nothing"). Legacy single-search
  // snapshots migrate into stack[0] on load.
  searchStack: SearchState[];
  searchTags: (string | null)[];
  // Open-order of overlay layers ("search0".."searchN", "s0".."sN",
  // "artist") — the restore assigns z values in this order so the
  // stacking matches the live session exactly (the old restore always
  // put the artist on top, flipping artist-under-stack sessions and
  // feeding the black-screen obscured-layer bug class).
  layerOrder: string[];
}

export type SnapshotInput = Omit<AppSnapshot, "v">;

export function saveSnapshot(snap: SnapshotInput): void {
  try {
    const out: AppSnapshot = {
      v: 1,
      feedType: snap.feedType,
      rankContent: snap.rankContent,
      rankMode: snap.rankMode,
      newestR18: snap.newestR18,
      topMode: snap.topMode,
      bookmarkVis: snap.bookmarkVis === "private" ? "private" : "public",
      // A tag folder only exists on the public list; don't carry a stale
      // tag across a private pile save.
      bookmarkTag:
        snap.bookmarkVis === "private" ? "" : (snap.bookmarkTag ?? "").slice(0, 64),
      stack: snap.stack.slice(0, MAX_STACK_DEPTH_HARD),
      artist: snap.artist,
      recs: snap.recs.slice(0, MAX_SNAPSHOT_ITEMS),
      recsSource: snap.recsSource,
      modalOpen: snap.modalOpen,
      searchStack: snap.searchStack
        .slice(0, MAX_SEARCH_DEPTH_HARD)
        .map((s) => ({
          ...s,
          works: s.works.slice(-MAX_SNAPSHOT_ITEMS),
          users: s.users.slice(0, 30),
        })),
      searchTags: snap.searchTags.slice(0, MAX_SEARCH_DEPTH_HARD),
      layerOrder: Array.isArray(snap.layerOrder) ? [...snap.layerOrder] : [],
    };
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    // private-mode localStorage can throw — restore simply won't happen
  }
}

export function loadSnapshot(caps?: {
  maxStackDepth?: number;
  maxSearchDepth?: number;
}): AppSnapshot | null {
  // Live pref caps when the caller already has them (the boot GET can
  // land before the rehydrate in a future boot order); otherwise the
  // hard bound. Never the default: clipping a snapshot saved under a
  // higher cap would silently discard layers the user could page back
  // through. Restoring ABOVE a later-lowered cap is safe — pushes use
  // the live cap, and the badge just shows e.g. 12/5.
  const maxStack = Math.min(
    MAX_STACK_DEPTH_HARD,
    Math.max(1, caps?.maxStackDepth ?? MAX_STACK_DEPTH_HARD)
  );
  const maxSearch = Math.min(
    MAX_SEARCH_DEPTH_HARD,
    Math.max(1, caps?.maxSearchDepth ?? MAX_SEARCH_DEPTH_HARD)
  );
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    // Legacy fields (pre-multi-search) may exist in old snapshots and
    // feed the migration below.
    const parsed = JSON.parse(raw) as (Partial<AppSnapshot> & {
      searchOpen?: boolean;
      search?: SearchState | null;
    }) | null;
    if (!parsed || parsed.v !== 1) return null;
    if (
      typeof parsed.feedType !== "string" ||
      !Array.isArray(parsed.stack) ||
      !Array.isArray(parsed.recs)
    ) {
      return null;
    }
    // Validate the search stack BEFORE deriving searchTags: the arrays
    // are parallel, and the restore in App.tsx maps tags[i] over the
    // VALIDATED stack.
    const searchStack: SearchState[] = Array.isArray(parsed.searchStack)
      ? parsed.searchStack
          .map(sanitizeSearchState)
          .filter((s): s is SearchState => s !== null)
          .slice(0, maxSearch)
      : // Legacy single-search snapshots migrate into stack[0].
        (() => {
          const legacy = sanitizeSearchState(parsed.search);
          return legacy ? [legacy] : [];
        })();

    const rawTags: (string | null)[] = Array.isArray(parsed.searchTags)
      ? parsed.searchTags
          .slice(0, maxSearch)
          .map((t) => (typeof t === "string" ? t : null))
      : parsed.search && typeof parsed.search.word === "string"
        ? [parsed.search.word]
        : [];
    // A saved tags array that doesn't match the validated stack — a
    // hand-edited snapshot, or entries the filter above dropped — would
    // make the restore read past the stack end or silently lose layers.
    // Pad with null / truncate to the stack length.
    const searchTags = searchStack.map((_, i) => rawTags[i] ?? null);

    return {
      v: 1,
      feedType: FEED_TYPES.includes(parsed.feedType) ? parsed.feedType : "home",
      rankContent: parsed.rankContent ?? "all",
      rankMode: parsed.rankMode ?? "day",
      newestR18: !!parsed.newestR18,
      topMode: parsed.topMode ?? "all",
      bookmarkVis: parsed.bookmarkVis === "private" ? "private" : "public",
      bookmarkTag:
        parsed.bookmarkVis === "private"
          ? ""
          : typeof parsed.bookmarkTag === "string"
            ? parsed.bookmarkTag.slice(0, 64)
            : "",
      stack: (parsed.stack as unknown[])
        .filter(isRenderableIllustEntry)
        .slice(0, maxStack),
      artist:
        parsed.artist &&
        typeof parsed.artist.id === "number" &&
        typeof parsed.artist.name === "string"
          ? { id: parsed.artist.id, name: parsed.artist.name }
          : null,
      recs: (parsed.recs as unknown[]).filter(isRenderableIllustEntry),
      recsSource: parsed.recsSource ?? "",
      modalOpen: !!parsed.modalOpen,
      searchStack,
      searchTags,
      layerOrder:
        Array.isArray(parsed.layerOrder) &&
        parsed.layerOrder.every((k) => typeof k === "string")
          ? (parsed.layerOrder as string[])
          : [],
    };
  } catch {
    return null;
  }
}
