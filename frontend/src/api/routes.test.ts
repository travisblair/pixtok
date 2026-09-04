import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as feeds from "./feeds";
import * as search from "./search";
import * as bookmarks from "./bookmarks";
import * as follow from "./follow";
import * as illust from "./illust";
import * as prefs from "./prefs";
import * as auth from "./auth";

// Every route's wire shape: exact URL, method, and body. Route-shape
// drift — double prefixes, missing required params, wrong methods — is
// the bug class that retries can never fix. Pin them all.
describe("api route shapes by domain", () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? String(init.body) : undefined,
      });
      return new Response(JSON.stringify({ illusts: [], next_url: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const shape = (c: { url: string; method: string; body?: string }) =>
    `${c.method} ${c.url}${c.body ? ` :: ${c.body}` : ""}`;

  it("feeds", async () => {
    await feeds.getTop();
    await feeds.getTop("week");
    await feeds.getTopIllust();
    await feeds.getNewest(true, "9000");
    await feeds.getNewestNext("/api/newest?r18=true&lastId=9000");
    await feeds.getStreet("");
    await feeds.getRecommended();
    const nextUrl = "https://app-api.pixiv.net/v1/illust/recommended?x=1";
    await feeds.getNextPage(nextUrl);
    expect(calls.map(shape)).toEqual([
      "GET /api/top?mode=day",
      "GET /api/top?mode=week",
      "GET /api/topillust?mode=all",
      "GET /api/newest?r18=true&lastId=9000",
      "GET /api/newest?r18=true&lastId=9000",
      "POST /api/street :: {}",
      "GET /api/recommended",
      `GET /api/next?url=${encodeURIComponent(nextUrl)}`,
    ]);
  });

  it("search", async () => {
    await search.searchArtworks({ word: "summer" });
    await search.searchArtworks({ word: "summer", workType: "ugoira", scd: "2024-01-01", p: 3 });
    await search.searchUsers("nick", 2);
    await search.getUgoiraMeta(9);
    expect(calls.map(shape)).toEqual([
      "GET /api/search/artworks?word=summer&order=date_d&mode=all&s_mode=s_tag_full&type=all&ai_type=0",
      "GET /api/search/artworks?word=summer&order=date_d&mode=all&s_mode=s_tag_full&type=ugoira&ai_type=0&scd=2024-01-01&p=3",
      "GET /api/search/users?nick=nick&s_mode=s_usr&p=2",
      "GET /api/illust/9/ugoira_meta",
    ]);
  });

  it("bookmarks ids and tags", async () => {
    await bookmarks.getBookmarkIds();
    await bookmarks.getBookmarkTags();
    expect(calls.map(shape)).toEqual([
      "GET /api/bookmarks/ids",
      "GET /api/bookmarks/tags",
    ]);
  });

  it("follow and user", async () => {
    await follow.follow(7);
    await follow.unfollow(7);
    await follow.getFollowed(7);
    await follow.getUserIllusts(7);
    expect(calls.map(shape)).toEqual([
      "POST /api/user/7/follow",
      "POST /api/user/7/unfollow",
      "GET /api/user/7/followed",
      "GET /api/user/7/illusts",
    ]);
  });

  it("illust actions", async () => {
    await illust.like(9);
    await illust.unlike(9);
    await illust.getRelated(9);
    await illust.getWorkRecs(9);
    expect(calls.map(shape)).toEqual([
      "POST /api/illust/9/like",
      "POST /api/illust/9/unlike",
      "GET /api/illust/9/related",
      "GET /api/illust/9/recs",
    ]);
  });

  it("prefs", async () => {
    await prefs.getBlockedTags();
    await prefs.setBlockedTags(["a", "b"]);
    await prefs.getImageSize();
    await prefs.setImageSize("medium");
    await prefs.getFeedViewMode();
    await prefs.setFeedViewMode("grid");
    await prefs.getArtistViewMode();
    await prefs.setArtistViewMode("grid");
    expect(calls.map(shape)).toEqual([
      "GET /api/prefs/blocked-tags",
      'PUT /api/prefs/blocked-tags :: {"tags":["a","b"]}',
      "GET /api/prefs/image-size",
      'PUT /api/prefs/image-size :: {"value":"medium"}',
      "GET /api/prefs/feed-view-mode",
      'PUT /api/prefs/feed-view-mode :: {"value":"grid"}',
      "GET /api/prefs/artist-view-mode",
      'PUT /api/prefs/artist-view-mode :: {"value":"grid"}',
    ]);
  });

  it("auth", async () => {
    await auth.getAuthStatus();
    await auth.gateStatus();
    await auth.gateUnlock("pw");
    expect(calls.map(shape)).toEqual([
      "GET /api/auth/status",
      "GET /api/gate/status",
      'POST /api/gate :: {"password":"pw"}',
    ]);
  });
});
