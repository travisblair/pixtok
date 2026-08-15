import type { PixivIllust } from "./types";
import type { SearchState } from "./components/SearchScreen";

/**
 * Reload-safe app state: survives iOS jetsam kills (localStorage, not
 * sessionStorage). Snapshot shape is versioned — old or corrupt payloads
 * load as null and the app starts fresh.
 *
 * Contents:
 *  - active feed + pill selections
 *  - the loaded feed (illusts + pagination cursor) — truncated to the
 *    last MAX_ITEMS works so the payload stays small
 *  - the main feed's scroll position (cards are 100dvh, so restoring
 *    scrollTop lands exactly)
 *  - the related-view stack (anchor works only — each level refetches
 *    its related list on mount)
 *  - the recs modal (its work list + source title + open flag)
 */

const KEY = "pixtok_state_v1";

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
  illusts: PixivIllust[];
  nextUrl: string | null;
  scrollTop: number;
  stack: PixivIllust[];
  artist: { id: number; name: string } | null;
  recs: PixivIllust[];
  recsSource: string;
  modalOpen: boolean;
  searchOpen: boolean;
  search: SearchState | null;
}

export type SnapshotInput = Omit<AppSnapshot, "v">;

export function saveSnapshot(snap: SnapshotInput): void {
  try {
    // The saved list is the LAST MAX_SNAPSHOT_ITEMS works, so the
    // scroll position must be made RELATIVE to that window — an
    // absolute scrollTop from a long feed would exceed the truncated
    // DOM height on restore and clamp to the bottom of the window
    // (reviewer finding: users always landed at the deepest card).
    let scrollTop = snap.scrollTop;
    const total = snap.illusts.length;
    if (total > MAX_SNAPSHOT_ITEMS) {
      const cardH = typeof window !== "undefined" ? window.innerHeight : 0;
      if (cardH > 0) {
        scrollTop = Math.max(
          0,
          scrollTop - (total - MAX_SNAPSHOT_ITEMS) * cardH
        );
      }
    }
    const out: AppSnapshot = {
      v: 1,
      feedType: snap.feedType,
      rankContent: snap.rankContent,
      rankMode: snap.rankMode,
      newestR18: snap.newestR18,
      topMode: snap.topMode,
      illusts: snap.illusts.slice(-MAX_SNAPSHOT_ITEMS),
      nextUrl: snap.nextUrl,
      scrollTop: Math.max(0, Math.round(scrollTop)),
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
      !Array.isArray(parsed.illusts) ||
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
      illusts: parsed.illusts,
      nextUrl: typeof parsed.nextUrl === "string" ? parsed.nextUrl : null,
      scrollTop: typeof parsed.scrollTop === "number" ? parsed.scrollTop : 0,
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
    };
  } catch {
    return null;
  }
}
