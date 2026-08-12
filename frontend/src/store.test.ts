import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getLikeState,
  seedLikedIds,
  clearLikeStates,
  blockedTags,
  addBlockedTag,
  removeBlockedTag,
  setBlockedTagsList,
  clearBlockedTags,
  imageSize,
  setImageSize,
  setImageSizeFromServer,
  clearImageSize,
} from "./store";

// The store calls the REAL api module (test-setup imports store.ts before
// per-file vi.mock hoisting, so mocking ./api misses). Stub fetch at the
// network edge instead — this also exercises the real request path.
let fetchCalls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  clearLikeStates();
  clearBlockedTags();
  clearImageSize();
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ tags: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("like state (server-seeded)", () => {
  it("seeds hearts from the bookmarks endpoint", () => {
    const s = getLikeState(42, false);
    expect(s.liked()).toBe(false);
    seedLikedIds([42]);
    expect(s.liked()).toBe(true);
  });

  it("seeding re-renders already-mounted hearts", () => {
    const s = getLikeState(7, false); // mounted before the seed lands
    seedLikedIds([7]);
    expect(s.liked()).toBe(true);
  });

  it("unlike removes the id from the seeded set", () => {
    seedLikedIds([9]);
    const s = getLikeState(9, false);
    s.setLiked(false);
    expect(s.liked()).toBe(false);
  });

  it("still honours a true server seed", () => {
    const s = getLikeState(11, true);
    expect(s.liked()).toBe(true);
  });
});

describe("blocked tags (backend-backed)", () => {
  it("loads via setBlockedTagsList", () => {
    setBlockedTagsList(["loli", "swimsuit"]);
    expect(blockedTags()).toEqual(["loli", "swimsuit"]);
  });

  it("add/remove update the list and PUT the full array", () => {
    addBlockedTag(" Swimsuit ");
    expect(blockedTags()).toEqual(["swimsuit"]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("/api/prefs/blocked-tags");
    expect(fetchCalls[0].init?.method).toBe("PUT");
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
      tags: ["swimsuit"],
    });

    addBlockedTag("Loli");
    expect(blockedTags()).toEqual(["swimsuit", "loli"]);

    removeBlockedTag("swimsuit");
    expect(blockedTags()).toEqual(["loli"]);
    const last = fetchCalls[fetchCalls.length - 1];
    expect(JSON.parse(last.init?.body as string)).toEqual({ tags: ["loli"] });
  });
});

describe("image size (backend-backed)", () => {
  it("defaults to large and applies the server value without a PUT", () => {
    expect(imageSize()).toBe("large");
    setImageSizeFromServer("medium");
    expect(imageSize()).toBe("medium");
    expect(fetchCalls).toHaveLength(0);
  });

  it("persists a user change via PUT", () => {
    setImageSize("medium");
    expect(imageSize()).toBe("medium");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("/api/prefs/image-size");
    expect(fetchCalls[0].init?.method).toBe("PUT");
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
      value: "medium",
    });
  });
});
