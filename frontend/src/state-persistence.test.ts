import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  saveSnapshot,
  loadSnapshot,
  MAX_SNAPSHOT_ITEMS,
  MAX_STACK_DEPTH,
  type SnapshotInput,
} from "./state-persistence";
import { makeIllust } from "./test-fixtures";

const KEY = "pixtok_state_v2";

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
    searchOpen: false,
    search: null,
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
