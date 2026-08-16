import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  saveSnapshot,
  loadSnapshot,
  MAX_SNAPSHOT_ITEMS,
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
    illusts: [makeIllust({ id: 1 }), makeIllust({ id: 2 })],
    nextUrl: "/api/newest?r18=false&lastId=5",
    scrollTop: 402 * 3,
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
  it("round-trips the full state", () => {
    const snap = baseSnapshot();
    saveSnapshot(snap);
    const loaded = loadSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded!.feedType).toBe("home");
    expect(loaded!.rankMode).toBe("day");
    expect(loaded!.newestR18).toBe(false);
    expect(loaded!.illusts.map((i) => i.id)).toEqual([1, 2]);
    expect(loaded!.nextUrl).toBe("/api/newest?r18=false&lastId=5");
    expect(loaded!.scrollTop).toBe(402 * 3);
    expect(loaded!.stack.map((i) => i.id)).toEqual([9]);
    expect(loaded!.artist).toEqual({ id: 42, name: "ArtistName" });
    expect(loaded!.recs.map((i) => i.id)).toEqual([11]);
    expect(loaded!.recsSource).toBe("Source");
    expect(loaded!.modalOpen).toBe(true);
  });

  it("defaults artist to null when absent or malformed", () => {
    const snap = baseSnapshot();
    snap.artist = null;
    saveSnapshot(snap);
    expect(loadSnapshot()!.artist).toBeNull();

    localStorage.setItem(
      KEY,
      JSON.stringify({ v: 1, feedType: "home", illusts: [], stack: [], recs: [], artist: { id: "x" } })
    );
    expect(loadSnapshot()!.artist).toBeNull();
  });

  it("truncates the feed and recs to the last MAX_SNAPSHOT_ITEMS works", () => {
    const snap = baseSnapshot();
    snap.illusts = Array.from({ length: MAX_SNAPSHOT_ITEMS + 40 }, (_, i) =>
      makeIllust({ id: i + 1 })
    );
    snap.recs = Array.from({ length: MAX_SNAPSHOT_ITEMS + 5 }, (_, i) =>
      makeIllust({ id: 1000 + i })
    );
    saveSnapshot(snap);
    const loaded = loadSnapshot()!;
    expect(loaded.illusts.length).toBe(MAX_SNAPSHOT_ITEMS);
    expect(loaded.illusts[0].id).toBe(41); // oldest dropped
    expect(loaded.recs.length).toBe(MAX_SNAPSHOT_ITEMS);
  });

  it("makes scrollTop relative to the truncated window (deep-scroll restore)", () => {
    // Reviewer finding (Qwen): scrollTop was saved ABSOLUTE while the
    // work list was truncated to the last 100 — restoring a deep scroll
    // (e.g. card 45 of 140) clamped to the bottom of the truncated
    // window instead of the user's actual position.
    const snap = baseSnapshot();
    snap.illusts = Array.from({ length: MAX_SNAPSHOT_ITEMS + 40 }, (_, i) =>
      makeIllust({ id: i + 1 })
    );
    const cardH = 768; // jsdom default innerHeight
    // Absolute scroll: 40 truncated cards + 5 cards into the window.
    snap.scrollTop = 45 * cardH;
    saveSnapshot(snap);
    const loaded = loadSnapshot()!;
    expect(loaded.scrollTop).toBe(5 * cardH);
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
      JSON.stringify({ v: 1, feedType: "home", illusts: "nope" })
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
