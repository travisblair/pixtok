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
    if (ill && typeof ill.id === "string") {
      const n = Number(ill.id);
      // Reviewer finding: never store a lossy number. Ids beyond
      // Number.MAX_SAFE_INTEGER keep their exact string form.
      if (Number.isSafeInteger(n)) ill.id = n;
    }
    if (ill && ill.user && typeof ill.user.id === "string") {
      const n = Number(ill.user.id);
      if (Number.isSafeInteger(n)) ill.user.id = n;
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
      if (user && typeof user.id === "string") {
        const n = Number(user.id);
        if (Number.isSafeInteger(n)) user.id = n;
      }
      normalizeIllustIds(user.previews);
    }
  }
  return feed;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch (err) {
    // AbortError = superseded by a newer request (like double-taps) —
    // not a failure. Timeouts and network drops surface in the toast.
    const name = abortName(err);
    if (name === "TimeoutError") onRequestError?.("Request timed out");
    else if (name !== "AbortError") onRequestError?.("Network error");
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Mid-session gate re-lock: the app boots unlocked, then the gate
    // cookie leaves the client (iOS Safari eviction, private-mode
    // teardown, profile switch). Gate status is only checked at boot,
    // so without this every subsequent view degrades into a silent
    // empty/error state — hidden follow buttons, dead feeds. Surface
    // the GateScreen instead (App registers the listener on mount).
    if (res.status === 403 && text.includes("gate locked")) {
      onGateLocked?.();
    } else {
      // Every other failure surfaces in the red error toast (2s, tap
      // to dismiss) — a failed feed, follow state, or like should
      // never pass silently.
      onRequestError?.(`Request failed (${res.status})`);
    }
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  try {
    const data = await res.json();
    return normalizeIds(data) as T;
  } catch (err) {
    onRequestError?.("Bad response");
    throw err;
  }
}

function abortName(err: unknown): string | null {
  return typeof err === "object" && err !== null && "name" in err
    ? String((err as { name?: unknown }).name)
    : null;
}

// Listener for mid-session gate re-locks (see request()). App registers
// it on mount and clears it on cleanup; kept out of the api object so
// request() can call it without a circular reference.
let onGateLocked: (() => void) | null = null;

export function setOnGateLocked(handler: (() => void) | null) {
  onGateLocked = handler;
}

// Listener for request failures (see request()). App renders the red
// top error toast; gate locks and superseded-request aborts are the
// only failures that stay silent here (they have their own UX).
let onRequestError: ((message: string) => void) | null = null;

export function setOnRequestError(handler: ((message: string) => void) | null) {
  onRequestError = handler;
}

// Client session id: tags breadcrumb events so one page load's story
// can be reconstructed from the server journal (the phone has no
// DevTools — the journal IS the console).
const CLIENT_SESSION = Math.random().toString(36).slice(2, 8);

/**
 * Fire-and-forget breadcrumb to the backend journal (POST /api/log).
 * Deliberately NOT request(): a logging failure must never surface in
 * the error toast or the gate-lock flow, and never throw.
 */
export function logEvent(scope: string, msg: string, data?: unknown) {
  try {
    void fetch(`${BASE}/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: CLIENT_SESSION, scope, msg, data }),
    }).catch(() => {
      // breadcrumb delivery is best-effort; silence is fine
    });
  } catch {
    // logging must never break the app
  }
}

// Preference writes serialize through this queue (reviewer finding:
// rapid PUTs can complete out of order — ["a"], ["a","b","c"], ["a","b"]
// — leaving the DB at a stale state). Chaining guarantees the last
// issued write is the last applied. Errors don't break the chain.
let prefsWriteQueue: Promise<unknown> = Promise.resolve();
function queuedPrefWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = prefsWriteQueue.then(fn, fn);
  prefsWriteQueue = run.catch(() => {});
  return run;
}

export const api = {
  getTop(mode: import("./types").RankingMode = "day") {
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

  // Continuation of a newest page — next_url arrives as a relative
  // "/api/newest?...". request() prepends the /api base, so the prefix
  // must come OFF first: passing it through untouched fetched
  // /api/api/newest — a 404 on every continuation (retry can't help,
  // the URL is structurally wrong).
  getNewestNext(url: string) {
    return request<import("./types").FeedResponse>(url.replace(/^\/api/, ""), {
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
    await queuedPrefWrite(() =>
      request<{ tags: string[] }>("/prefs/blocked-tags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
        signal: AbortSignal.timeout(10_000),
      })
    );
  },

  getImageSize() {
    return request<{ value: "large" | "medium" }>("/prefs/image-size", {
      signal: AbortSignal.timeout(10_000),
    });
  },

  async setImageSize(value: string) {
    await queuedPrefWrite(() =>
      request<{ value: string }>("/prefs/image-size", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
        signal: AbortSignal.timeout(10_000),
      })
    );
  },

  // View modes (strip | grid) — feed tabs and artist pages toggle
  // independently; both default strip. Same prefs-DB pattern as
  // image-size: GET at boot, PUT on change (queued so rapid toggles
  // apply in order).
  getFeedViewMode() {
    return request<{ value: "strip" | "grid" }>("/prefs/feed-view-mode", {
      signal: AbortSignal.timeout(10_000),
    });
  },

  async setFeedViewMode(value: string) {
    await queuedPrefWrite(() =>
      request<{ value: string }>("/prefs/feed-view-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
        signal: AbortSignal.timeout(10_000),
      })
    );
  },

  getArtistViewMode() {
    return request<{ value: "strip" | "grid" }>("/prefs/artist-view-mode", {
      signal: AbortSignal.timeout(10_000),
    });
  },

  async setArtistViewMode(value: string) {
    await queuedPrefWrite(() =>
      request<{ value: string }>("/prefs/artist-view-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
        signal: AbortSignal.timeout(10_000),
      })
    );
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

  // The Bookmarks tab feed — the bookmarks PAGE (web AJAX, crawl-
  // verified): tag filter + blind offset pagination. next_url arrives as
  // a self-referential /api/bookmarks?tag=...&offset=... URL.
  // The backend REQUIRES an offset (400 without one — the first load
  // once omitted it and every page-open 400'd), so page-0 loads pin
  // offset=0 here; continuations ride next_url.
  getBookmarks(tag = "") {
    return request<import("./types").FeedResponse>(
      `/bookmarks?tag=${encodeURIComponent(tag)}&offset=0`,
      { signal: AbortSignal.timeout(15_000) }
    );
  },

  // Continuation: next_url carries its own /api prefix — strip it like
  // getNewestNext (request() prepends the base).
  getBookmarksNext(url: string) {
    return request<import("./types").FeedResponse>(url.replace(/^\/api/, ""), {
      signal: AbortSignal.timeout(15_000),
    });
  },

  getBookmarkTags() {
    return request<{
      public: { name: string; count: number }[];
      private: { name: string; count: number }[];
    }>("/bookmarks/tags", { signal: AbortSignal.timeout(15_000) });
  },

  // Follow (live-verified app-API endpoints). restrict is fixed public
  // server-side — following is a public action on pixiv.
  follow(userId: number) {
    return request<{ ok: boolean }>(`/user/${userId}/follow`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
  },

  unfollow(userId: number) {
    return request<{ ok: boolean }>(`/user/${userId}/unfollow`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
  },

  getFollowed(userId: number) {
    // followed is null while the backend's 429 circuit breaker is
    // cooling: "unknown" is not an error — the button just stays hidden.
    return request<{ followed: boolean | null }>(`/user/${userId}/followed`, {
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
      // 60s, not 15: the meta hop rides the Pi relay and iOS-tailscale
      // stalls are a real failure mode on the phone (the server journal
      // showed an /api/img request dying at exactly 15.002s — a client
      // abort at its old 15s deadline). The zip already allows 120s;
      // meta and poster should not give up 8x sooner.
      signal: AbortSignal.timeout(60_000),
    });
  },
};
