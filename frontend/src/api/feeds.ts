import { request } from "./client";
import type { FeedResponse, RankingMode } from "../types";

// Ranking feed (app-API /v1/illust/ranking passthrough).
export function getTop(mode: RankingMode = "day") {
  return request<FeedResponse>(`/top?mode=${mode}`, {
    signal: AbortSignal.timeout(15_000),
  });
}

// Newest-upload firehose (new_illust.php). lastId is the page cursor.
export function getNewest(r18 = false, lastId = "") {
  const params = `r18=${r18}${lastId ? `&lastId=${lastId}` : ""}`;
  return request<FeedResponse>(`/newest?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
}

// Continuation of a newest page — next_url arrives as a relative
// "/api/newest?...". request() prepends the /api base, so the prefix
// must come OFF first: passing it through untouched fetched
// /api/api/newest — a 404 on every continuation (retry can't help,
// the URL is structurally wrong).
export function getNewestNext(url: string) {
  return request<FeedResponse>(url.replace(/^\/api/, ""), {
    signal: AbortSignal.timeout(15_000),
  });
}

// /illustration top page feed (mode all|r18). No pagination upstream.
export function getTopIllust(mode = "all") {
  return request<FeedResponse>(`/topillust?mode=${mode}`, {
    signal: AbortSignal.timeout(15_000),
  });
}

// Street feed (personalized Home). The body is the nextParams cursor
// JSON from the previous response (empty for the first page). It is
// opaque data owned by the backend — never a URL, so no SSRF surface.
export function getStreet(cursor: string) {
  return request<FeedResponse>("/street", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: cursor || "{}",
    signal: AbortSignal.timeout(20_000),
  });
}

export function getRecommended() {
  return request<FeedResponse>("/recommended", {
    signal: AbortSignal.timeout(15_000),
  });
}

export function getNextPage(nextUrl: string) {
  return request<FeedResponse>(`/next?url=${encodeURIComponent(nextUrl)}`, {
    signal: AbortSignal.timeout(15_000),
  });
}
