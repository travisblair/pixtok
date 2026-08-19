import type { PixivIllust } from "./types";
import type { SearchState } from "./components/SearchScreen";

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
// Max related-stack depth — the UI refusal and the snapshot truncation
// must share ONE source of truth or they silently desync.
export const MAX_STACK_DEPTH = 10;

export interface AppSnapshot {
  v: 1;
  feedType: string;
  rankContent: string;
  rankMode: string;
  newestR18: boolean;
  topMode: string;
  stack: PixivIllust[];
  artist: { id: number; name: string } | null;
  recs: PixivIllust[];
  recsSource: string;
  modalOpen: boolean;
  searchOpen: boolean;
  search: SearchState | null;
  // Open-order of overlay layers ("search", "s0".."sN", "artist") — the
  // restore assigns z values in this order so the stacking matches the
  // live session exactly (the old restore always put the artist on top,
  // flipping artist-under-stack sessions and feeding the black-screen
  // obscured-layer bug class).
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
      stack: snap.stack.slice(0, MAX_STACK_DEPTH),
      artist: snap.artist,
      recs: snap.recs.slice(0, MAX_SNAPSHOT_ITEMS),
      recsSource: snap.recsSource,
      modalOpen: snap.modalOpen,
      searchOpen: snap.searchOpen,
      search: snap.search
        ? {
            ...snap.search,
            works: snap.search.works.slice(-MAX_SNAPSHOT_ITEMS),
            users: snap.search.users.slice(0, 30),
          }
        : null,
      layerOrder: Array.isArray(snap.layerOrder) ? [...snap.layerOrder] : [],
    };
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    // private-mode localStorage can throw — restore simply won't happen
  }
}

export function loadSnapshot(): AppSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppSnapshot> | null;
    if (!parsed || parsed.v !== 1) return null;
    if (
      typeof parsed.feedType !== "string" ||
      !Array.isArray(parsed.stack) ||
      !Array.isArray(parsed.recs)
    ) {
      return null;
    }
    return {
      v: 1,
      feedType: parsed.feedType,
      rankContent: parsed.rankContent ?? "all",
      rankMode: parsed.rankMode ?? "day",
      newestR18: !!parsed.newestR18,
      topMode: parsed.topMode ?? "all",
      stack: parsed.stack,
      artist:
        parsed.artist &&
        typeof parsed.artist.id === "number" &&
        typeof parsed.artist.name === "string"
          ? { id: parsed.artist.id, name: parsed.artist.name }
          : null,
      recs: parsed.recs,
      recsSource: parsed.recsSource ?? "",
      modalOpen: !!parsed.modalOpen,
      searchOpen: !!parsed.searchOpen,
      search:
        parsed.search &&
        typeof parsed.search === "object" &&
        typeof parsed.search.word === "string" &&
        Array.isArray(parsed.search.works) &&
        Array.isArray(parsed.search.users)
          ? (parsed.search as SearchState)
          : null,
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
