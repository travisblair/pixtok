import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  saveSnapshot,
  loadSnapshot,
  MAX_SNAPSHOT_ITEMS,
  MAX_STACK_DEPTH,
  type SnapshotInput,
} from "./state-persistence";
import type { SearchState } from "./components/SearchScreen";
import { makeIllust } from "./test-fixtures";

const KEY = "pixtok_state_v2";

/** Full-shaped SearchState for raw-payload fixtures (honest typing —
 *  the loader's filter only needs word/works/users, but a real
 *  snapshot page carries every field). */
function makeSearchState(word: string): SearchState {
  return {
    word,
    mode: "works",
    order: "date_d",
    contentMode: "all",
    workType: "all",
    sMode: "s_tag_full",
    aiType: "0",
    dateMode: "all",
    scd: "",
    sce: "",
    works: [],
    popular: [],
    related: [],
    users: [],
    page: 0,
    hasMore: false,
  };
}

function baseSnapshot(): SnapshotInput {
  return {
    feedType: "home",
    rankContent: "all",
    rankMode: "day",
    newestR18: false,
    topMode: "all",
    stack: [makeIllust({ id: 9 })],
    artist: { id: 42, name: "ArtistName" },
    recs: [makeIllust({ id: 11 })],
    recsSource: "Source",
    modalOpen: true,
    searchStack: [],
    searchTags: [],
    layerOrder: ["s0", "artist"],
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("saveSnapshot/loadSnapshot", () => {
  it("round-trips navigation + layer state (no feed content)", () => {
    const snap = baseSnapshot();
    saveSnapshot(snap);
    const loaded = loadSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded!.feedType).toBe("home");
    expect(loaded!.rankMode).toBe("day");
    expect(loaded!.newestR18).toBe(false);
    expect(loaded!.stack.map((i) => i.id)).toEqual([9]);
    expect(loaded!.artist).toEqual({ id: 42, name: "ArtistName" });
    expect(loaded!.recs.map((i) => i.id)).toEqual([11]);
    expect(loaded!.recsSource).toBe("Source");
    expect(loaded!.modalOpen).toBe(true);
  });

  it("tolerates legacy v:1 payloads that still carry feed fields", () => {
    // Pre-"feeds are always fresh" snapshots included illusts/nextUrl/
    // scrollTop. The loader ignores them — the feed loads fresh, the
    // layers still restore.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        feedType: "home",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        illusts: [makeIllust({ id: 700 })],
        nextUrl: "/api/newest?lastId=5",
        scrollTop: 1234,
        stack: [makeIllust({ id: 9 })],
        artist: { id: 42, name: "ArtistName" },
        recs: [],
        recsSource: "",
        modalOpen: false,
      })
    );
    const loaded = loadSnapshot()!;
    expect(loaded.stack.map((i) => i.id)).toEqual([9]);
    expect(loaded.artist).toEqual({ id: 42, name: "ArtistName" });
    expect("illusts" in loaded).toBe(false);
  });

  it("migrates a legacy single-search payload into searchStack[0]", () => {
    // Pre-multi-search snapshots carried searchOpen/search. The tag
    // identity is unknowable — the word stands in so the dedupe rule
    // still sees "this tag is open" after an upgrade.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        feedType: "home",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        stack: [],
        artist: null,
        recs: [],
        recsSource: "",
        modalOpen: false,
        searchOpen: true,
        search: {
          word: "snow",
          mode: "works",
          order: "date_d",
          contentMode: "all",
          workType: "all",
          sMode: "s_tag_full",
          aiType: "0",
          dateMode: "all",
          scd: "",
          sce: "",
          works: [],
          popular: [],
          related: [],
          users: [],
          page: 0,
          hasMore: false,
        },
        layerOrder: ["search", "s0"],
      })
    );
    const loaded = loadSnapshot()!;
    expect(loaded.searchStack.length).toBe(1);
    expect(loaded.searchStack[0].word).toBe("snow");
    expect(loaded.searchTags).toEqual(["snow"]);
  });

  it("defaults artist to null when absent or malformed", () => {
    const snap = baseSnapshot();
    snap.artist = null;
    saveSnapshot(snap);
    expect(loadSnapshot()!.artist).toBeNull();

    localStorage.setItem(
      KEY,
      JSON.stringify({ v: 1, feedType: "home", stack: [], recs: [], artist: { id: "x" } })
    );
    expect(loadSnapshot()!.artist).toBeNull();
  });

  it("truncates recs to the last MAX_SNAPSHOT_ITEMS works", () => {
    const snap = baseSnapshot();
    snap.recs = Array.from({ length: MAX_SNAPSHOT_ITEMS + 5 }, (_, i) =>
      makeIllust({ id: 1000 + i })
    );
    saveSnapshot(snap);
    const loaded = loadSnapshot()!;
    expect(loaded.recs.length).toBe(MAX_SNAPSHOT_ITEMS);
  });

  it("truncates the stack to MAX_STACK_DEPTH", () => {
    const snap = baseSnapshot();
    snap.stack = Array.from({ length: MAX_STACK_DEPTH + 3 }, (_, i) =>
      makeIllust({ id: i + 1 })
    );
    saveSnapshot(snap);
    const loaded = loadSnapshot()!;
    expect(loaded.stack.length).toBe(MAX_STACK_DEPTH);
  });

  it("drops stack/recs entries that only carry a numeric id", () => {
    // Review finding: the old id-only guard let {"id":5} through, it
    // reached FeedCard, and props.illust.user.name threw — the throw
    // escaped boot() and masqueraded as gate:unreachable (boot died,
    // GateScreen stayed up forever). A restored entry must carry the
    // render shape FeedCard reads unconditionally.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        feedType: "home",
        stack: [{ id: 5 }],
        recs: [{ id: 6 }],
        artist: null,
      })
    );
    const loaded = loadSnapshot()!;
    expect(loaded.stack).toEqual([]);
    expect(loaded.recs).toEqual([]);
  });

  it("drops entries with an incomplete user/image_urls shape and keeps well-formed ones", () => {
    const good = makeIllust({ id: 7 });
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        feedType: "home",
        stack: [
          { id: 6, user: { id: 1 } }, // user.name missing → would throw
          { id: 8, user: { id: 1, name: "A" }, image_urls: { medium: "m" } }, // image_urls.large missing
          good,
        ],
        recs: [],
        artist: null,
      })
    );
    const loaded = loadSnapshot()!;
    expect(loaded.stack.map((i) => i.id)).toEqual([7]);
  });

  it("pads searchTags to the validated searchStack length", () => {
    // App.tsx restores `searchStack: snap.searchTags.map((tag, i) => ...)`
    // — a tags array shorter than the validated stack must not silently
    // drop layers (or index z-values out of range); the loader pads.
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        feedType: "home",
        stack: [],
        recs: [],
        artist: null,
        searchStack: [makeSearchState("snow"), makeSearchState("rain")],
        searchTags: ["snow"],
      })
    );
    const loaded = loadSnapshot()!;
    expect(loaded.searchStack.length).toBe(2);
    expect(loaded.searchTags).toEqual(["snow", null]);
  });

  it("truncates searchTags to the validated searchStack length", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        feedType: "home",
        stack: [],
        recs: [],
        artist: null,
        searchStack: [makeSearchState("snow")],
        searchTags: ["snow", "rain", "wind"],
      })
    );
    const loaded = loadSnapshot()!;
    expect(loaded.searchTags).toEqual(["snow"]);
  });

  it("aligns searchTags to the stack length AFTER invalid entries are dropped", () => {
    // The saved tags array matched the raw array; the validated stack is
    // one shorter because {word} alone lacks works/users. The trailing
    // tag must not survive (the restore indexes tags[i] over the
    // VALIDATED stack).
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        feedType: "home",
        stack: [],
        recs: [],
        artist: null,
        searchStack: [makeSearchState("snow"), { word: "dropped" }],
        searchTags: ["snow", "dropped-tag"],
      })
    );
    const loaded = loadSnapshot()!;
    expect(loaded.searchStack.length).toBe(1);
    expect(loaded.searchTags).toEqual(["snow"]);
  });

  it("returns null for corrupt JSON", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadSnapshot()).toBeNull();
  });

  it("returns null for a wrong-version payload", () => {
    localStorage.setItem(KEY, JSON.stringify({ v: 0, feedType: "home" }));
    expect(loadSnapshot()).toBeNull();
  });

  it("returns null for a payload with broken arrays", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ v: 1, feedType: "home", stack: "nope", recs: [] })
    );
    expect(loadSnapshot()).toBeNull();
  });

  it("survives a localStorage that throws (private mode)", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    expect(() => saveSnapshot(baseSnapshot())).not.toThrow();
    spy.mockRestore();
  });
});
