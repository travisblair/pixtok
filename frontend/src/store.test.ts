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
  feedViewMode,
  setFeedViewMode,
  setFeedViewModeFromServer,
  clearFeedViewMode,
  artistViewMode,
  setArtistViewMode,
  setArtistViewModeFromServer,
  clearArtistViewMode,
  maxStackDepth,
  setMaxStackDepth,
  setMaxStackDepthFromServer,
  normalizeMaxStackDepth,
  isMaxStackDepthLoaded,
  clearMaxStackDepth,
} from "./store";

// The store calls the REAL api module (test-setup imports store.ts before
// per-file vi.mock hoisting, so mocking ./api misses). Stub fetch at the
// network edge instead — this also exercises the real request path.
let fetchCalls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  clearLikeStates();
  clearBlockedTags();
  clearImageSize();
  clearFeedViewMode();
  clearArtistViewMode();
  clearMaxStackDepth();
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

  it("merges a late boot seed with edits made while it was in flight", async () => {
    // The user blocks a tag before the boot GET answers: the seed carries
    // the server's PRE-edit list and must not replace the working copy.
    addBlockedTag("swimsuit");
    setBlockedTagsList(["loli"]);
    // Union of server truth + the local add (order: seed first).
    expect(blockedTags()).toEqual(["loli", "swimsuit"]);
    // The edit's own PUT carried only [swimsuit], so the merged truth is
    // written back — otherwise the next boot would forget "loli".
    await vi.waitFor(() => {
      const last = fetchCalls[fetchCalls.length - 1];
      expect(JSON.parse(last.init?.body as string)).toEqual({
        tags: ["loli", "swimsuit"],
      });
    });
  });

  it("honours a removal made while the seed was in flight", () => {
    // Tombstoned removal: a seed that still lists the tag must not
    // resurrect it (e.g. the unblock tap landed before the GET answered).
    removeBlockedTag("loli");
    setBlockedTagsList(["loli", "swimsuit"]);
    expect(blockedTags()).toEqual(["swimsuit"]);
  });

  it("a seed after the first one still replaces (last write wins)", () => {
    setBlockedTagsList(["a"]);
    setBlockedTagsList(["b"]);
    expect(blockedTags()).toEqual(["b"]);
  });

  it("normalizes the seed like the PUT path (trim, lowercase, dedupe)", () => {
    setBlockedTagsList([" Swimsuit ", "swimsuit", "", "Loli"]);
    expect(blockedTags()).toEqual(["swimsuit", "loli"]);
  });

  it("add/remove update the list and PUT the full array", async () => {
    addBlockedTag(" Swimsuit ");
    expect(blockedTags()).toEqual(["swimsuit"]);
    // Pref writes serialize through a promise queue — flush two
    // microtask ticks before asserting the fetch.
    await Promise.resolve();
    await Promise.resolve();
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
    await vi.waitFor(() => {
      const last = fetchCalls[fetchCalls.length - 1];
      expect(JSON.parse(last.init?.body as string)).toEqual({ tags: ["loli"] });
    });
  });
});

describe("image size (backend-backed)", () => {
  it("defaults to large and applies the server value without a PUT", () => {
    expect(imageSize()).toBe("large");
    setImageSizeFromServer("medium");
    expect(imageSize()).toBe("medium");
    expect(fetchCalls).toHaveLength(0);
  });

  it("persists a user change via PUT", async () => {
    setImageSize("medium");
    expect(imageSize()).toBe("medium");
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("/api/prefs/image-size");
    expect(fetchCalls[0].init?.method).toBe("PUT");
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
      value: "medium",
    });
  });
});


describe("view modes (backend-backed)", () => {
  it("default to strip and apply server values without a PUT", () => {
    expect(feedViewMode()).toBe("strip");
    expect(artistViewMode()).toBe("strip");
    setFeedViewModeFromServer("grid");
    setArtistViewModeFromServer("grid");
    expect(feedViewMode()).toBe("grid");
    expect(artistViewMode()).toBe("grid");
    expect(fetchCalls).toHaveLength(0);
  });

  it("treat unknown server values as strip", () => {
    setFeedViewModeFromServer("carousel");
    setArtistViewModeFromServer("");
    expect(feedViewMode()).toBe("strip");
    expect(artistViewMode()).toBe("strip");
  });

  it("persists a user change via PUT, one call per mode", async () => {
    setFeedViewMode("grid");
    setArtistViewMode("grid");
    expect(feedViewMode()).toBe("grid");
    expect(artistViewMode()).toBe("grid");
    await vi.waitFor(() => {
      expect(fetchCalls).toHaveLength(2);
    });
    const urls = fetchCalls.map((c) => c.url).sort();
    expect(urls).toEqual([
      "/api/prefs/artist-view-mode",
      "/api/prefs/feed-view-mode",
    ]);
    for (const c of fetchCalls) {
      expect(c.init?.method).toBe("PUT");
      expect(JSON.parse(c.init?.body as string)).toEqual({ value: "grid" });
    }
  });
});

// ONE pref caps both overlay stacks: default 10, 0 (or garbage) = default,
// clamp 1..30. Normalization happens locally before the PUT so the UI and
// the DB can never disagree.
describe("max stack depth (backend-backed)", () => {
  it("defaults to 10 and applies the server value without a PUT", () => {
    expect(maxStackDepth()).toBe(10);
    expect(isMaxStackDepthLoaded()).toBe(false);
    setMaxStackDepthFromServer(24);
    expect(maxStackDepth()).toBe(24);
    expect(isMaxStackDepthLoaded()).toBe(true);
    expect(fetchCalls).toHaveLength(0);
  });

  it("normalizes 0 / empty / non-numeric / out-of-range values", () => {
    expect(normalizeMaxStackDepth(0)).toBe(10);
    expect(normalizeMaxStackDepth("0")).toBe(10);
    expect(normalizeMaxStackDepth("")).toBe(10);
    expect(normalizeMaxStackDepth("abc")).toBe(10);
    expect(normalizeMaxStackDepth(null)).toBe(10);
    expect(normalizeMaxStackDepth(1)).toBe(1);
    expect(normalizeMaxStackDepth(30)).toBe(30);
    expect(normalizeMaxStackDepth(31)).toBe(30);
    expect(normalizeMaxStackDepth(-4)).toBe(1);
    expect(normalizeMaxStackDepth("12")).toBe(12);
  });

  it("clamps a corrupt server value to the default", () => {
    setMaxStackDepthFromServer("nonsense");
    expect(maxStackDepth()).toBe(10);
  });

  it("persists a normalized user change via PUT", async () => {
    setMaxStackDepth("0");
    expect(maxStackDepth()).toBe(10);
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toBe("/api/prefs/max-stack-depth");
    expect(fetchCalls[0].init?.method).toBe("PUT");
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
      value: 10,
    });

    setMaxStackDepth(99);
    expect(maxStackDepth()).toBe(30);
    await vi.waitFor(() => expect(fetchCalls).toHaveLength(2));
    expect(JSON.parse(fetchCalls[1].init?.body as string)).toEqual({
      value: 30,
    });
  });
});

// The per-id like-signal map is capped: a long session scrolling
// hundreds of works must not grow memory unbounded (reviewer finding).
// Oldest entries evict first.
describe("likeStates cap", () => {
  afterEach(clearLikeStates);

  it("evicts the oldest entries past the cap", () => {
    for (let i = 0; i < 1100; i++) {
      getLikeState(i, false);
    }
    // 1100 inserts, cap 1024 — the first 76 ids must be gone, and a
    // re-fetch of id 0 must create a FRESH entry (not resurrect state).
    const fresh = getLikeState(0, true);
    expect(fresh.liked()).toBe(true);
  });
});
