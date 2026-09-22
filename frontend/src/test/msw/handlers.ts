import { http, HttpResponse } from "msw";
import { zipSync } from "fflate";
import { makeFeedOf } from "../../test-fixtures";
import { isRankingMode } from "../../types";

/**
 * Default MSW handlers for the pixtok /api surface.
 *
 * SOURCE OF TRUTH for every shape below:
 *   - frontend/src/api/*.ts                — the path/method/query each caller sends
 *   - backend/handlers.go + backend/gate.go — status codes + validation the server applies
 *   - frontend/e2e/fixtures/api-mocks.js   — the e2e mirror of those same shapes
 *
 * House rule: handlers are as STRICT as the backend. A lenient handler
 * that "repairs" a malformed request is a bug-mask — /api/bookmarks
 * without an offset once shipped a real 400 to production because a
 * mock defaulted the missing param. Mirror the backend's strictness:
 * a wire-shape drift must fail the test, not get quietly answered.
 *
 * The server is global (see ./setup.ts) so components run the REAL
 * api/*.ts functions → request() → fetch(); MSW answers at the HTTP
 * boundary. Per-test variations use server.use(...) (reset after each
 * test) instead of per-module vi.mock factories.
 */

/** JSON response mirroring the backend's writeJSON helper. */
export function json(body: unknown, status = 200) {
  return HttpResponse.json(body as never, { status });
}

/** Plain-text error mirroring the backend's http.Error(w, msg, status). */
function err(message: string, status: number) {
  return new HttpResponse(`${message}\n`, { status });
}

// ── Fixture payloads ────────────────────────────────────────────────
// Id ranges stay descriptive (street 1.., top 1000.., recs 500..,
// related 900.., …) so cross-feed bleed is visible in assertions.

/** Default street (personalized Home) page — mirrors App.test's old wiring. */
export const STREET = makeFeedOf(30, 1);
/** Continuation page for a street cursor body (never indexed in unit tests). */
export const STREET_NEXT = makeFeedOf(10, 5000);
export const TOP = makeFeedOf(30, 1000);
export const RECOMMENDED = makeFeedOf(5, 500);
export const WORK_RECS = makeFeedOf(5, 500);
export const RELATED = makeFeedOf(8, 900);
export const NEXT_PAGE = makeFeedOf(10, 100);
export const USER_ILLUSTS = makeFeedOf(6, 600);
export const BOOKMARK_PAGE = makeFeedOf(8, 4000);
export const BOOKMARKS_PRIVATE = makeFeedOf(6, 9801);
export const SEARCH_ARTWORKS = {
  illusts: makeFeedOf(3, 2000).illusts,
  total: 900,
  last_page: 1,
  page: 1,
  next_url: null,
  popular: [] as never[],
  related_tags: [] as never[],
};

/**
 * Ugoira metadata (GET /api/illust/:id/ugoira_meta) — web-AJAX
 * passthrough shape per backend/handlers.go + e2e fixtures: the zip
 * URL lives in body.src, frames carry per-frame delays.
 */
export function ugoiraMeta(illustId: number, frames = [
  { file: "000000.jpg", delay: 100 },
  { file: "000001.jpg", delay: 200 },
]) {
  return {
    error: false,
    body: {
      src: `https://img-zip-ugoira.i.pximg.net/mock/${illustId}_ugoira600x600.zip`,
      originalSrc: `https://img-zip-ugoira.i.pximg.net/mock/${illustId}_ugoira1920x1080.zip`,
      mime_type: "image/jpeg",
      frames,
    },
  };
}

/** Minimal valid zip with two fake "frames" — matches ugoiraMeta()'s frame list. */
export function ugoiraZip(files: Record<string, Uint8Array> = {
  "000000.jpg": new Uint8Array([1, 2, 3]),
  "000001.jpg": new Uint8Array([4, 5, 6]),
}): Uint8Array {
  return zipSync(files, { level: 0 });
}

/**
 * 1×1 transparent PNG — the image-proxy answer for non-ugoira URLs.
 * Exported so per-test /api/img overrides (UgoiraPlayer's stalled /
 * malformed-zip specs) can keep the poster branch faithful instead of
 * hand-rolling bytes.
 */
export const ONE_PX_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

/**
 * Backend /api/log scope allowlist (handlers.go: gesture, layers,
 * follow, gate, boot, app, ugoira, crash). Breadcrumbs with any other
 * scope 400 server-side — the journal would silently lose them.
 */
const LOG_SCOPES = new Set([
  "gesture",
  "layers",
  "follow",
  "gate",
  "boot",
  "app",
  "ugoira",
  "crash",
]);

/** Valid USER/ILLUST ids are decimal ints (pixiv.ValidID). */
function validId(raw: string | undefined): raw is string {
  return !!raw && /^\d+$/.test(raw);
}

/** 1..1000 page params (handlers.go: "invalid page" 400). */
function parsePage(raw: string | null): number | null {
  if (raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1000) return null;
  return n;
}

// Stateful prefs — the e2e mock is stateful too (a toggle PUT survives
// a reload: boot GETs read back the last written value). Reset per test.
const prefsState = {
  blockedTags: [] as string[],
  imageSize: "large",
  feedViewMode: "strip",
  artistViewMode: "strip",
};

export function resetPrefsState() {
  prefsState.blockedTags = [];
  prefsState.imageSize = "large";
  prefsState.feedViewMode = "strip";
  prefsState.artistViewMode = "strip";
}

/** Prefs value routes share one shape: GET {"value": v} / PUT {"value": v}. */
function prefValueHandler(
  allowed: string[],
  get: () => string,
  set: (v: string) => void,
  label: string
) {
  return [
    http.get(`/api/prefs/${label}`, () => json({ value: get() })),
    http.put(`/api/prefs/${label}`, async ({ request }) => {
      const body = (await request.json().catch(() => null)) as {
        value?: unknown;
      } | null;
      const value =
        body && typeof body.value === "string" ? body.value.trim() : "";
      if (!allowed.includes(value)) return err(`invalid ${label}`, 400);
      set(value);
      return json({ value });
    }),
  ];
}

export const handlers = [
  // ── POST /api/log — client breadcrumbs ─────────────────────────────
  // logEvent() is fire-and-forget (api/client.ts) — it must never throw
  // or surface in the error toast. Backend validates the JSON body and
  // the scope allowlist; mirror both so a typo'd scope is visible here
  // (the journal would silently drop it in production).
  http.post("/api/log", async ({ request }) => {
    const entry = (await request.json().catch(() => null)) as {
      scope?: unknown;
    } | null;
    if (!entry) return err("invalid body", 400);
    if (typeof entry.scope !== "string" || !LOG_SCOPES.has(entry.scope)) {
      return err("invalid scope", 400);
    }
    return json({ ok: true });
  }),

  // ── Auth + gate (api/auth.ts, backend/gate.go) ─────────────────────
  http.get("/api/auth/status", () =>
    json({ app_api: true, web_session: true })
  ),
  http.get("/api/gate/status", () => json({ locked: false })),
  // POST /api/gate: JSON content type REQUIRED (gate.go 415s anything
  // else), body must carry a string password. A wrong password is a
  // 401 "wrong password" — tests override with that when needed.
  http.post("/api/gate", async ({ request }) => {
    if (request.headers.get("Content-Type") !== "application/json") {
      return err("invalid content type", 415);
    }
    const body = (await request.json().catch(() => null)) as {
      password?: unknown;
    } | null;
    if (!body || typeof body.password !== "string") {
      return err("invalid body", 400);
    }
    return json({ ok: true });
  }),

  // ── Feeds (api/feeds.ts, backend/handlers.go) ──────────────────────
  // POST /api/street: the body is the nextParams cursor JSON from the
  // previous response ("" for the first page). Cursor payloads are
  // opaque server-side data; malformed JSON is a 400.
  http.post("/api/street", async ({ request }) => {
    const raw = (await request.text()).trim();
    const isFirstPage = raw === "" || raw === "{}";
    if (!isFirstPage) {
      try {
        JSON.parse(raw);
      } catch {
        return err("invalid body", 400);
      }
    }
    return json(isFirstPage ? STREET : STREET_NEXT);
  }),
  // GET /api/top?mode= — the mode is whitelisted upstream (appapi.go
  // rankingModes); anything else is a 400 "invalid ranking mode".
  http.get("/api/top", ({ request }) => {
    const mode = new URL(request.url).searchParams.get("mode") ?? "";
    if (!isRankingMode(mode)) return err("invalid ranking mode", 400);
    return json(TOP);
  }),
  http.get("/api/recommended", () => json(RECOMMENDED)),
  // GET /api/next?url= — the backend forwards ONLY absolute app-api
  // URLs (pixiv.validAPIHost); anything else is an upstream error. The
  // e2e mock mirrors this exact strictness so a URL-mangling regression
  // cannot stay green (a double prefix / relative URL is a 502, not a
  // served page).
  http.get("/api/next", ({ request }) => {
    const target = new URL(request.url).searchParams.get("url");
    if (!target) return err("missing url param", 400);
    if (!target.startsWith("https://app-api.pixiv.net/")) {
      return err("upstream error", 502);
    }
    return json(NEXT_PAGE);
  }),

  // ── Per-work feeds (api/illust.ts) ────────────────────────────────
  http.get("/api/illust/:id/recs", ({ params }) => {
    if (!validId(String(params.id))) return err("invalid illust id", 400);
    return json(WORK_RECS);
  }),
  http.get("/api/illust/:id/related", ({ params }) => {
    if (!validId(String(params.id))) return err("invalid illust id", 400);
    return json(RELATED);
  }),
  // POST only — account-mutating routes reject GETs (handlers.go).
  http.post("/api/illust/:id/like", ({ params }) => {
    if (!validId(String(params.id))) return err("invalid illust id", 400);
    return json({ ok: true });
  }),
  http.post("/api/illust/:id/unlike", ({ params }) => {
    if (!validId(String(params.id))) return err("invalid illust id", 400);
    return json({ ok: true });
  }),

  // ── Ugoira (api/search.ts) ────────────────────────────────────────
  http.get("/api/illust/:id/ugoira_meta", ({ params }) => {
    const id = String(params.id);
    if (!validId(id)) return err("invalid illust id", 400);
    return json(ugoiraMeta(Number(id)));
  }),

  // ── Follow + artist library (api/follow.ts) ───────────────────────
  http.post("/api/user/:id/follow", ({ params }) => {
    if (!validId(String(params.id))) return err("invalid user id", 400);
    return json({ ok: true });
  }),
  http.post("/api/user/:id/unfollow", ({ params }) => {
    if (!validId(String(params.id))) return err("invalid user id", 400);
    return json({ ok: true });
  }),
  // followed is null while the backend's 429 circuit breaker cools —
  // "unknown" hides the button without an error (handlers.go).
  http.get("/api/user/:id/followed", ({ params }) => {
    if (!validId(String(params.id))) return err("invalid user id", 400);
    return json({ followed: false });
  }),
  http.get("/api/user/:id/illusts", ({ params }) => {
    if (!validId(String(params.id))) return err("invalid user id", 400);
    return json(USER_ILLUSTS);
  }),

  // ── Search (api/search.ts) ────────────────────────────────────────
  // GET /api/search/artworks: page must be 1..1000 when present
  // (handlers.go "invalid page"); word is the caller's contract.
  http.get("/api/search/artworks", ({ request }) => {
    const url = new URL(request.url);
    const word = url.searchParams.get("word") ?? "";
    if (!word) return err("invalid parameter", 400);
    const page = parsePage(url.searchParams.get("p"));
    if (page === null) return err("invalid page", 400);
    return json({ ...SEARCH_ARTWORKS, page });
  }),
  http.get("/api/search/users", ({ request }) => {
    const url = new URL(request.url);
    const nick = url.searchParams.get("nick") ?? "";
    if (!nick) return err("invalid parameter", 400);
    const page = parsePage(url.searchParams.get("p"));
    if (page === null) return err("invalid page", 400);
    return json({ users: [], total: 0, page, next_url: null });
  }),

  // ── Bookmarks (api/bookmarks.ts) ──────────────────────────────────
  http.get("/api/bookmarks/ids", ({ request }) => {
    const raw = new URL(request.url).searchParams.get("pages");
    if (raw !== null) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 10)
        return err("invalid pages", 400);
    }
    return json({ ids: [] });
  }),
  // GET /api/bookmarks?tag=&offset= — the backend REQUIRES an offset
  // (400 without one: the first load once omitted it and every
  // page-open 400'd in production while a lenient mock kept the suite
  // green). No default: a missing offset fails the test loudly.
  http.get("/api/bookmarks", ({ request }) => {
    const url = new URL(request.url);
    const tag = url.searchParams.get("tag") ?? "";
    if (tag.length > 64) return err("invalid tag", 400);
    const offsetRaw = url.searchParams.get("offset");
    if (offsetRaw === null) return err("invalid offset", 400);
    const offset = Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
      return err("invalid offset", 400);
    const order = url.searchParams.get("order") ?? "desc";
    if (order !== "desc" && order !== "asc") return err("invalid order", 400);
    return json(offset === 0 ? BOOKMARK_PAGE : { illusts: [], next_url: null });
  }),
  http.get("/api/bookmarks/private", () => json(BOOKMARKS_PRIVATE)),
  http.get("/api/bookmarks/tags", () => json({ public: [], private: [] })),

  // ── Prefs (api/prefs.ts, handlers.go registerPrefs) ───────────────
  http.get("/api/prefs/blocked-tags", () => json({ tags: prefsState.blockedTags })),
  // PUT normalizes like the backend (lowercase, trim, dedupe) and
  // echoes the cleaned list.
  http.put("/api/prefs/blocked-tags", async ({ request }) => {
    const body = (await request.json().catch(() => null)) as {
      tags?: unknown;
    } | null;
    if (!body || !Array.isArray(body.tags)) return err("invalid body", 400);
    const clean: string[] = [];
    const seen = new Set<string>();
    for (const t of body.tags) {
      if (typeof t !== "string") continue;
      const v = t.trim().toLowerCase();
      if (v === "" || v.length > 64 || seen.has(v)) continue;
      seen.add(v);
      clean.push(v);
    }
    if (clean.length > 200) return err("too many tags", 400);
    prefsState.blockedTags = clean;
    return json({ tags: clean });
  }),
  ...prefValueHandler(
    ["large", "medium"],
    () => prefsState.imageSize,
    (v) => (prefsState.imageSize = v),
    "image-size"
  ),
  ...prefValueHandler(
    ["strip", "grid"],
    () => prefsState.feedViewMode,
    (v) => (prefsState.feedViewMode = v),
    "feed-view-mode"
  ),
  ...prefValueHandler(
    ["strip", "grid"],
    () => prefsState.artistViewMode,
    (v) => (prefsState.artistViewMode = v),
    "artist-view-mode"
  ),

  // ── GET /api/img?url=… (image proxy) ──────────────────────────────
  // Ugoira zips come back as real zip bytes (fflate inflates them for
  // real); everything else is a 1×1 PNG. Both shapes mirror the e2e
  // fixture and the backend's proxy semantics.
  http.get("/api/img", ({ request }) => {
    const target = new URL(request.url).searchParams.get("url") ?? "";
    if (!target) return err("missing url param", 400);
    if (target.includes("img-zip-ugoira")) {
      return new HttpResponse(ugoiraZip(), {
        headers: { "Content-Type": "application/zip" },
      });
    }
    return new HttpResponse(ONE_PX_PNG, {
      headers: { "Content-Type": "image/png" },
    });
  }),
];

/**
 * Fallback for /api paths with no handler above — a loud failure
 * instead of a silent pass-through. Requests land here, the response is
 * a 500 the UI can't mistake for success, and ./setup.ts fails the test
 * in afterEach with the offending path(s).
 */
export const fallbackHandler = http.all("/api/*", ({ request }) => {
  const { pathname } = new URL(request.url);
  unhandledApiRequests.push(`${request.method} ${pathname}`);
  return json(
    { error: `UNHANDLED /api route — add a handler to src/test/msw/handlers.ts` },
    500
  );
});

/** /api paths that reached the fallback during the current test. */
export const unhandledApiRequests: string[] = [];
