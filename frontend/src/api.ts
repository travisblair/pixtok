const BASE = "/api";

/**
 * Backend feeds emit illust ids inconsistently: the web-AJAX transforms
 * (street/top/recs) marshal ids as JSON strings, while the app-API
 * passthroughs (recommended/related/next) carry numeric ids. Normalize
 * every illust id + user id to number here so the whole frontend — the
 * dedupe set, related-view comparisons, like/unlike calls — sees ONE
 * wire contract.
 */
function normalizeIllustIds(items: unknown[] | undefined) {
  if (!items) return;
  for (const item of items) {
    const ill = item as { id?: string | number; user?: { id?: string | number } };
    if (ill && typeof ill.id === "string") ill.id = Number(ill.id);
    if (ill && ill.user && typeof ill.user.id === "string") {
      ill.user.id = Number(ill.user.id);
    }
  }
}

function normalizeIds(data: unknown): unknown {
  const feed = data as {
    illusts?: unknown[];
    popular?: unknown[];
    users?: unknown[];
  } | null;
  if (!feed) return data;
  normalizeIllustIds(feed.illusts);
  normalizeIllustIds(feed.popular);
  if (Array.isArray(feed.users)) {
    for (const u of feed.users) {
      const user = u as { id?: string | number; previews?: unknown[] };
      if (user && typeof user.id === "string") user.id = Number(user.id);
      normalizeIllustIds(user.previews);
    }
  }
  return feed;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  const data = await res.json();
  return normalizeIds(data) as T;
}

export const api = {
  getTop(mode = "day") {
    return request<import("./types").FeedResponse>(`/top?mode=${mode}`, {
      signal: AbortSignal.timeout(15_000),
    });
  },

  // Newest-upload firehose (new_illust.php). lastId is the page cursor.
  getNewest(r18 = false, lastId = "") {
    const params = `r18=${r18}${lastId ? `&lastId=${lastId}` : ""}`;
    return request<import("./types").FeedResponse>(`/newest?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
  },

  // Continuation of a newest page — next_url is a relative /api/newest
  // path, so fetch it as-is through the same proxy.
  getNewestNext(url: string) {
    return request<import("./types").FeedResponse>(url, {
      signal: AbortSignal.timeout(15_000),
    });
  },

  // /illustration top page feed (mode all|r18). No pagination upstream.
  getTopIllust(mode = "all") {
    return request<import("./types").FeedResponse>(`/topillust?mode=${mode}`, {
      signal: AbortSignal.timeout(15_000),
    });
  },

  // Login capture health: both auth surfaces probed server-side.
  getAuthStatus() {
    return request<{ app_api: boolean; web_session: boolean }>("/auth/status", {
      signal: AbortSignal.timeout(15_000),
    });
  },

  // App-owned password gate (the Funnel is public).
  gateStatus() {
    return request<{ locked: boolean }>("/gate/status", {
      signal: AbortSignal.timeout(10_000),
    });
  },

  async gateUnlock(password: string) {
    await request<{ ok: boolean }>("/gate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(15_000),
    });
  },

  // The user's bookmarked illust ids — pixiv's bookmarks endpoint is the
  // source of truth for heart state (web feeds don't carry it).
  getBookmarkIds() {
    return request<{ ids: number[] }>("/bookmarks/ids", {
      signal: AbortSignal.timeout(30_000),
    });
  },

  // Blocked tags live in the backend prefs DB (localStorage proved
  // unreliable on iOS).
  getBlockedTags() {
    return request<{ tags: string[] }>("/prefs/blocked-tags", {
      signal: AbortSignal.timeout(10_000),
    });
  },

  async setBlockedTags(tags: string[]) {
    await request<{ tags: string[] }>("/prefs/blocked-tags", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(10_000),
    });
  },

  getImageSize() {
    return request<{ value: "large" | "medium" }>("/prefs/image-size", {
      signal: AbortSignal.timeout(10_000),
    });
  },

  async setImageSize(value: string) {
    await request<{ value: string }>("/prefs/image-size", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(10_000),
    });
  },

  // Search — the site's search pages. Works search carries the tag's
  // popular block (the search-page recommendations) + related tags.
  // Filter params are the verified set (live-probed Aug 2026): order,
  // mode, work type (endpoint switch), s_mode, ai_type, scd/sce.
  searchArtworks(params: {
    word: string;
    order?: string;
    contentMode?: "all" | "safe" | "r18";
    workType?: "all" | "illust" | "ugoira";
    sMode?: string;
    aiType?: "0" | "1";
    scd?: string;
    sce?: string;
    p?: number;
  }) {
    const q = new URLSearchParams({
      word: params.word,
      order: params.order ?? "date_d",
      mode: params.contentMode ?? "all",
      // s_tag_full: matches this account's saved search defaults (the
      // site's FRESH default is partial match — s_tag — per the Aug
      // 2026 modal crawl; pixtok keeps exact as the default).
      s_mode: params.sMode ?? "s_tag_full",
      type: params.workType ?? "all",
      ai_type: params.aiType ?? "0",
    });
    if (params.scd) q.set("scd", params.scd);
    if (params.sce) q.set("sce", params.sce);
    if (params.p) q.set("p", String(params.p));
    return request<import("./types").SearchArtworksResponse>(
      `/search/artworks?${q}`,
      { signal: AbortSignal.timeout(15_000) }
    );
  },

  searchUsers(nick: string, p: number) {
    const q = new URLSearchParams({ nick, s_mode: "s_usr", p: String(p) });
    return request<import("./types").SearchUsersResponse>(
      `/search/users?${q}`,
      { signal: AbortSignal.timeout(15_000) }
    );
  },

  // Street feed (personalized Home). The body is the nextParams cursor
  // JSON from the previous response (empty for the first page). It is
  // opaque data owned by the backend — never a URL, so no SSRF surface.
  getStreet(cursor: string) {
    return request<import("./types").FeedResponse>("/street", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: cursor || "{}",
      signal: AbortSignal.timeout(20_000),
    });
  },

  // The Bookmarks tab feed (app-API passthrough, private by default —
  // pixtok likes are private). Pagination rides /api/next.
  getBookmarks() {
    return request<import("./types").FeedResponse>("/bookmarks", {
      signal: AbortSignal.timeout(15_000),
    });
  },

  getRecommended() {
    return request<import("./types").FeedResponse>("/recommended", {
      signal: AbortSignal.timeout(15_000),
    });
  },

  // Per-work recommendations (recommend/init — the same "Related works"
  // section the pixiv.net artwork page shows). DISTINCT from getRelated:
  // the tap-stack uses the app-API similarity engine (paginated), while
  // the like-modal uses this site engine (finite ~18). Both are per-work;
  // they're just two different recommendation systems.
  getWorkRecs(illustId: number, signal?: AbortSignal) {
    return request<import("./types").FeedResponse>(
      `/illust/${illustId}/recs`,
      { signal: signal ?? AbortSignal.timeout(15_000) }
    );
  },

  getNextPage(nextUrl: string) {
    return request<import("./types").FeedResponse>(
      `/next?url=${encodeURIComponent(nextUrl)}`,
      { signal: AbortSignal.timeout(15_000) }
    );
  },

  // Like/unlike are POSTs with a JSON {ok:true} body — route them
  // through the shared request helper (same error shape and timeout
  // discipline as every other call).
  like(illustId: number) {
    return request<{ ok: boolean }>(`/illust/${illustId}/like`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
  },

  unlike(illustId: number) {
    return request<{ ok: boolean }>(`/illust/${illustId}/unlike`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
  },

  // Tap-stack related works (v2/illust/related — app-API similarity
  // engine, paginated). Distinct from getWorkRecs (recommend/init, the
  // site's per-work section used by the like-modal).
  getRelated(illustId: number) {
    return request<import("./types").FeedResponse>(
      `/illust/${illustId}/related`,
      { signal: AbortSignal.timeout(15_000) }
    );
  },

  // Artist's works (app API, paginated).
  getUserIllusts(userId: number) {
    return request<import("./types").FeedResponse>(
      `/user/${userId}/illusts`,
      { signal: AbortSignal.timeout(15_000) }
    );
  },

  // Ugoira animation metadata (web AJAX passthrough).
  getUgoiraMeta(illustId: number) {
    return request<{
      error: boolean;
      body: {
        src: string;
        originalSrc: string;
        mime_type: string;
        frames: { file: string; delay: number }[];
      };
    }>(`/illust/${illustId}/ugoira_meta`, {
      signal: AbortSignal.timeout(15_000),
    });
  },
};
