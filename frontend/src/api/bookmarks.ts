import { request } from "./client";
import type { FeedResponse } from "../types";

// The user's bookmarked illust ids — pixiv's bookmarks endpoint is the
// source of truth for heart state (web feeds don't carry it).
export function getBookmarkIds() {
  return request<{ ids: number[] }>("/bookmarks/ids", {
    signal: AbortSignal.timeout(30_000),
  });
}

// The Bookmarks tab feed — the bookmarks PAGE (web AJAX, crawl-
// verified): tag filter + blind offset pagination. next_url arrives as
// a self-referential /api/bookmarks?tag=...&offset=... URL.
// The backend REQUIRES an offset (400 without one — the first load
// once omitted it and every page-open 400'd), so page-0 loads pin
// offset=0 here; continuations ride next_url.
export function getBookmarks(tag = "") {
  return request<FeedResponse>(
    `/bookmarks?tag=${encodeURIComponent(tag)}&offset=0`,
    { signal: AbortSignal.timeout(15_000) }
  );
}

// Continuation: next_url carries its own /api prefix — strip it like
// getNewestNext (request() prepends the base).
export function getBookmarksNext(url: string) {
  return request<FeedResponse>(url.replace(/^\/api/, ""), {
    signal: AbortSignal.timeout(15_000),
  });
}

export function getBookmarkTags() {
  return request<{
    public: { name: string; count: number }[];
    private: { name: string; count: number }[];
  }>("/bookmarks/tags", { signal: AbortSignal.timeout(15_000) });
}
