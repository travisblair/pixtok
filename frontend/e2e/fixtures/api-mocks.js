// ── API mock router (freezer-app style) ─────────────────────────────────
// setupApiMocks(page, options) intercepts EVERY /api path so e2e tests
// never touch the vite dev proxy → Go backend → real Pixiv. It returns a
// state object with recorded calls for assertions:
//   mocks.topModes, mocks.topCalls, mocks.recsCalls, mocks.likeCalls,
//   mocks.unlikeCalls, mocks.relatedCalls, mocks.nextCalls, mocks.imgCalls,
//   mocks.streetBodies
//
// Options (all optional, FeedResponse-or-array friendly):
//   topBatch       GET /api/top response            (default 30, next_url null)
//   topByMode      { all?, r18? } per-mode override for /api/top
//   streetBatch    POST /api/street page 1          (default 30, next_url null)
//   streetNextBatch POST /api/street page 2+        (default 10, next_url null)
//   recsBatch      GET /api/recommended response    (default 5, next_url null)
//   workRecsBatch  GET /api/illust/:id/recs         (default 5, next_url null)
//   relatedBatch   GET /api/illust/:id/related      (default 8, next_url null)
//   userBatch      GET /api/user/:id/illusts        (default 6, next_url null)
//   ugoiraBatch    GET /api/illust/:id/ugoira_meta  (default: 2-frame zip meta)
//   nextBatch      GET /api/next response           (default 10, next_url null)
//   newestBatch    GET /api/newest page 1           (default 20, next_url set)
//   newestNextBatch GET /api/newest continuation    (default 10, next_url null)
//   topIllustBatch GET /api/topillust               (default 30, next_url null)
//   likeFails      POST like → 500 (failure-path spec)
//   imgFailOnce    substring of a proxied image URL — the FIRST request
//                  matching it fails (500), later requests succeed
//                  (per-page retry spec)

import { makeFeedOf, ONE_PX_PNG_BASE64 } from "./mock-data.js";

// Minimal valid zip with two 1x1 PNG "frames" (000000.jpg, 000001.jpg)
// so the UgoiraPlayer's fflate+canvas path runs for real in e2e.
const UGOIRA_ZIP_B64 =
  "UEsDBBQAAAAAADS9DF2TIEkcRgAAAEYAAAAKAAAAMDAwMDAwLmpwZ4lQTkcNChoKAAAADUlIRFIAAAABAAAAAQgGAAAAHxXEiQAAAA1JREFUeNpjZPjPUA8AA4YBgFo0fWsAAAAASUVORK5CYIJQSwMEFAAAAAAANL0MXZMgSRxGAAAARgAAAAoAAAAwMDAwMDEuanBniVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJgglBLAQIUAxQAAAAAADS9DF2TIEkcRgAAAEYAAAAKAAAAAAAAAAAAAACAAQAAAAAwMDAwMDAuanBnUEsBAhQDFAAAAAAANL0MXZMgSRxGAAAARgAAAAoAAAAAAAAAAAAAAIABbgAAADAwMDAwMS5qcGdQSwUGAAAAAAIAAgBwAAAA3AAAAAAA";

function toResponse(batch) {
  // Accept either a FeedResponse object or a bare illust array.
  return Array.isArray(batch) ? { illusts: batch, next_url: null } : batch;
}

export async function setupApiMocks(page, options = {}) {
  const topBatch = toResponse(options.topBatch ?? makeFeedOf(30, 1, null));
  const topByMode = {};
  for (const [mode, batch] of Object.entries(options.topByMode ?? {})) {
    topByMode[mode] = toResponse(batch);
  }
  const streetBatch = toResponse(
    options.streetBatch ?? makeFeedOf(30, 1, null)
  );
  const streetNextBatch = toResponse(
    options.streetNextBatch ?? makeFeedOf(10, 5000, null)
  );
  const recsBatch = toResponse(options.recsBatch ?? makeFeedOf(5, 2001, null));
  const workRecsBatch = toResponse(
    options.workRecsBatch ?? makeFeedOf(5, 2001, null)
  );
  const relatedBatch = toResponse(
    options.relatedBatch ?? makeFeedOf(8, 3001, null)
  );
  const userBatch = toResponse(options.userBatch ?? makeFeedOf(6, 4001, null));
  const nextBatch = toResponse(options.nextBatch ?? makeFeedOf(10, 4001, null));
  const newestBatch = toResponse(
    options.newestBatch ?? makeFeedOf(20, 6001, "/api/newest?r18=false&lastId=5000")
  );
  const newestNextBatch = toResponse(
    options.newestNextBatch ?? makeFeedOf(10, 7001, null)
  );
  const topIllustBatch = toResponse(
    options.topIllustBatch ?? makeFeedOf(30, 8001, null)
  );
  // Search works response (page-1 shape with the popular block + tags).
  const searchBatch = options.searchBatch ?? {
    illusts: makeFeedOf(6, 9001, null).illusts,
    total: 60,
    last_page: 10,
    page: 1,
    next_url: null,
    popular: makeFeedOf(5, 9100, null).illusts,
    related_tags: [
      { name: "tag-one" },
      { name: "tag-two" },
      { name: "tag-three" },
      { name: "tag-four" },
      { name: "tag-five" },
      { name: "tag-six" },
    ],
  };
  const searchUsersBatch = options.searchUsersBatch ?? {
    users: [
      {
        id: 7001,
        name: "mock-artist-1",
        avatar: "https://i.pximg.net/user-profile/img/mock/7001.jpg",
        premium: false,
        is_followed: false,
        previews: makeFeedOf(3, 7101, null).illusts,
      },
      {
        id: 7002,
        name: "mock-artist-2",
        avatar: "https://i.pximg.net/user-profile/img/mock/7002.jpg",
        premium: false,
        is_followed: false,
        previews: makeFeedOf(3, 7201, null).illusts,
      },
    ],
    total: 2,
  };
  const likeFails = options.likeFails ?? false;
  // Fail the FIRST street continuation once (500), succeed afterwards —
  // exercises the "pagination failure must not auto-retry" path.
  const streetNextFailOnce = options.streetNextFailOnce ?? false;
  let streetNextFailed = false;
  // ALWAYS fail street continuations (persistent rate limit).
  const streetNextFails = options.streetNextFails ?? false;
  const imgFailOnce = options.imgFailOnce ?? null;

  const mocks = {
    topModes: [], // every `mode` query param observed on /api/top
    topCalls: 0,
    streetBodies: [], // every nextParams body POSTed to /api/street
    recsCalls: 0,
    workRecsCalls: [], // [{ id }]
    likeCalls: [], // [{ id }]
    unlikeCalls: [], // [{ id }]
    relatedCalls: [], // [{ id }]
    userCalls: [], // [{ id }]
    ugoiraCalls: [], // [{ id }]
    nextCalls: [], // [{ url }]
    newestCalls: [], // [{ r18, lastId }]
    topIllustModes: [], // every `mode` observed on /api/topillust
    searchCalls: [], // [{ word, order, r18, p }]
    searchUsersCalls: [], // [{ nick, p }]
    bookmarkCalls: [], // [{ tag, offset }]
    followedCalls: [], // [{ id }]
    followCalls: [], // [{ id }]
    unfollowCalls: [], // [{ id }]
    imgCalls: 0,
    imgFailures: [], // proxied URLs that got the fail-once 500
  };

  const json = (body, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  // ── HERMETICITY GUARD: any /api route a spec forgets to mock dies ─────
  // loudly here instead of leaking to the real Vite proxy → Go backend →
  // Pixiv. Playwright matches routes LIFO, so the specific routes below
  // (registered after this catch-all) always win.
  await page.route(/\api\//, (route) => {
    route.fulfill(
      json({ error: "UNMOCKED /api route — add it to setupApiMocks" }, 500)
    );
  });

  // ── GET /api/auth/status (login-capture health) ───────────────────────
  await page.route(/\/api\/auth\/status$/, (route) => {
    route.fulfill(
      json(options.authStatus ?? { app_api: true, web_session: true })
    );
  });

  // ── Gate (app-owned password) — always open in e2e ────────────────────
  await page.route(/\/api\/gate\/status$/, (route) => {
    route.fulfill(json({ locked: false }));
  });
  await page.route(/\/api\/gate$/, (route) => {
    route.fulfill(json({ ok: true }));
  });

  // ── Prefs (backend DB) — stateful so a toggle PUT survives a reload ──
  // and a reload's boot GETs read back the last written value (this is
  // what makes "toggle persists across reload" testable in e2e).
  const prefsState = {
    blockedTags: options.blockedTags ?? [],
    imageSize: options.imageSize ?? "large",
    feedViewMode: options.feedViewMode ?? "strip",
    artistViewMode: options.artistViewMode ?? "strip",
  };
  const prefsRoute = (pattern, key) =>
    page.route(pattern, (route) => {
      if (route.request().method() === "PUT") {
        try {
          const body = JSON.parse(route.request().postData() ?? "{}");
          prefsState[key] = body.tags ?? body.value ?? prefsState[key];
        } catch {
          // malformed body — keep the current value
        }
      }
      route.fulfill(
        json(key.startsWith("feedViewMode") || key.startsWith("artistViewMode") || key === "imageSize"
          ? { value: prefsState[key] }
          : { tags: prefsState[key] })
      );
    });
  await prefsRoute(/\/api\/prefs\/blocked-tags$/, "blockedTags");
  await prefsRoute(/\/api\/prefs\/image-size$/, "imageSize");
  await prefsRoute(/\/api\/prefs\/feed-view-mode$/, "feedViewMode");
  await prefsRoute(/\/api\/prefs\/artist-view-mode$/, "artistViewMode");

  // ── Bookmarks page (tag pills + offset pagination) ──────────────────
  // The seed must cover the bookmark-page works so their hearts render
  // bookmarked (an unliked heart on this page would LIKE on tap).
  await page.route(/\/api\/bookmarks\/ids$/, (route) => {
    route.fulfill(json({ ids: [9501, 9502, 9503, 9504, 9505, 9506] }));
  });
  // The (?<!\/api) lookbehind mirrors the newest route: a double-prefixed
  // URL must fall through to the hermeticity guard.
  await page.route(/(?<!\/api)\/api\/bookmarks\/tags$/, (route) => {
    route.fulfill(
      json({
        public: [{ name: "tag-one", count: 3 }],
        private: [],
      })
    );
  });
  await page.route(/(?<!\/api)\/api\/bookmarks(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const tag = url.searchParams.get("tag") ?? "";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    mocks.bookmarkCalls.push({ tag, offset });
    route.fulfill(
      json(
        offset === 0
          ? { illusts: makeFeedOf(6, 9501, null).illusts, next_url: "/api/bookmarks?tag=" + tag + "&offset=48" }
          : { illusts: [], next_url: null }
      )
    );
  });

  // ── Follow (artist header + card rows) ───────────────────────────────
  await page.route(/\/api\/user\/(\d+)\/followed$/, (route) => {
    const id = Number(route.request().url().match(/\/user\/(\d+)\/followed$/)[1]);
    mocks.followedCalls.push({ id });
    route.fulfill(json({ followed: false }));
  });
  await page.route(/\/api\/user\/(\d+)\/follow$/, (route) => {
    const id = Number(route.request().url().match(/\/user\/(\d+)\/follow$/)[1]);
    mocks.followCalls.push({ id });
    route.fulfill(json({ ok: true }));
  });
  await page.route(/\/api\/user\/(\d+)\/unfollow$/, (route) => {
    const id = Number(route.request().url().match(/\/user\/(\d+)\/unfollow$/)[1]);
    mocks.unfollowCalls.push({ id });
    route.fulfill(json({ ok: true }));
  });

  // ── GET /api/newest?r18=…&lastId=… (newest-upload firehose) ────────────
  // The (?<!\/api) lookbehind keeps a double-prefixed URL
  // (/api/api/newest) from matching — it must fall through to the
  // hermeticity guard and fail loudly instead of being swallowed by the
  // mock (that leniency hid the real continuation bug for weeks).
  await page.route(/(?<!\/api)\/api\/newest(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const r18 = url.searchParams.get("r18") === "true";
    const lastId = url.searchParams.get("lastId") ?? "";
    mocks.newestCalls.push({ r18, lastId });
    route.fulfill(json(lastId ? newestNextBatch : newestBatch));
  });

  // ── GET /api/topillust?mode=all|r18 (/illustration top page) ───────────
  await page.route(/\/api\/topillust(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const mode = url.searchParams.get("mode") ?? "all";
    mocks.topIllustModes.push(mode);
    route.fulfill(json(topIllustBatch));
  });

  // ── GET /api/top?mode=day|week|… (app-API ranking) ─────────────────────
  await page.route(/\/api\/top(\?|$)/, (route) => {
    const url = new URL(route.request().url());
    const mode = url.searchParams.get("mode") ?? "all";
    mocks.topModes.push(mode);
    mocks.topCalls++;
    route.fulfill(json(topByMode[mode] ?? topBatch));
  });

  // ── POST /api/street (personalized Home feed) ─────────────────────────
  await page.route(/\api\/street(\?|$)/, (route) => {
    const body = route.request().postData() ?? "";
    mocks.streetBodies.push(body);
    // Page 1 vs continuations: an empty/{} body is the first page, any
    // cursor JSON is a continuation (mirrors upstream nextParams). Keying
    // on the body (not call count) keeps feed REVISITS working: switching
    // tabs and back re-requests page 1 and must get streetBatch again.
    const isFirstPage = body === "" || body === "{}";
    if (streetNextFails && !isFirstPage) {
      route.fulfill(json({ error: "rate limited" }, 429));
      return;
    }
    if (streetNextFailOnce && !isFirstPage && !streetNextFailed) {
      streetNextFailed = true;
      route.fulfill(json({ error: "rate limited" }, 429));
      return;
    }
    const batch = isFirstPage ? streetBatch : streetNextBatch;
    route.fulfill(json(batch));
  });

  // ── GET /api/search/artworks & /api/search/users ─────────────────────
  await page.route(/\/api\/search\/artworks/, (route) => {
    const url = new URL(route.request().url());
    mocks.searchCalls.push({
      word: url.searchParams.get("word") ?? "",
      order: url.searchParams.get("order") ?? "",
      mode: url.searchParams.get("mode") ?? "all",
      s_mode: url.searchParams.get("s_mode") ?? "",
      type: url.searchParams.get("type") ?? "all",
      ai_type: url.searchParams.get("ai_type") ?? "0",
      scd: url.searchParams.get("scd") ?? "",
      sce: url.searchParams.get("sce") ?? "",
      p: Number(url.searchParams.get("p") ?? 1),
    });
    route.fulfill(json(searchBatch));
  });
  await page.route(/\/api\/search\/users/, (route) => {
    const url = new URL(route.request().url());
    mocks.searchUsersCalls.push({
      nick: url.searchParams.get("nick") ?? "",
      p: Number(url.searchParams.get("p") ?? 1),
    });
    route.fulfill(json(searchUsersBatch));
  });

  // ── GET /api/recommended (Discover feed) ──────────────────────────────
  await page.route(/\/api\/recommended(\?|$)/, (route) => {
    mocks.recsCalls++;
    route.fulfill(json(recsBatch));
  });

  // ── POST /api/illust/:id/like ─────────────────────────────────────────
  await page.route(/\/api\/illust\/(\d+)\/like$/, (route) => {
    const id = Number(route.request().url().match(/\/illust\/(\d+)\/like$/)[1]);
    mocks.likeCalls.push({ id });
    if (likeFails) {
      route.fulfill(json({ error: "internal server error" }, 500));
    } else {
      route.fulfill(json({ ok: true }));
    }
  });

  // ── POST /api/illust/:id/unlike ───────────────────────────────────────
  await page.route(/\/api\/illust\/(\d+)\/unlike$/, (route) => {
    const id = Number(
      route.request().url().match(/\/illust\/(\d+)\/unlike$/)[1]
    );
    mocks.unlikeCalls.push({ id });
    route.fulfill(json({ ok: true }));
  });

  // ── GET /api/illust/:id/recs (per-work recommendations, like-modal) ──
  await page.route(/\/api\/illust\/(\d+)\/recs$/, (route) => {
    const id = Number(route.request().url().match(/\/illust\/(\d+)\/recs$/)[1]);
    mocks.workRecsCalls.push({ id });
    route.fulfill(json(workRecsBatch));
  });

  // ── GET /api/illust/:id/related (tap-stack) ───────────────────────────
  await page.route(/\/api\/illust\/(\d+)\/related$/, (route) => {
    const id = Number(
      route.request().url().match(/\/illust\/(\d+)\/related$/)[1]
    );
    mocks.relatedCalls.push({ id });
    route.fulfill(json(relatedBatch));
  });

  // ── GET /api/user/:id/illusts (artist library) ────────────────────────
  await page.route(/\/api\/user\/(\d+)\/illusts$/, (route) => {
    const id = Number(route.request().url().match(/\/user\/(\d+)\/illusts$/)[1]);
    mocks.userCalls.push({ id });
    route.fulfill(json(userBatch));
  });

  // ── GET /api/illust/:id/ugoira_meta (animation metadata) ──────────────
  await page.route(/\/api\/illust\/(\d+)\/ugoira_meta$/, (route) => {
    const id = Number(
      route.request().url().match(/\/illust\/(\d+)\/ugoira_meta$/)[1]
    );
    mocks.ugoiraCalls.push({ id });
    route.fulfill(
      json({
        error: false,
        body: {
          src: `https://img-zip-ugoira.i.pximg.net/mock/${id}_ugoira600x600.zip`,
          originalSrc: `https://img-zip-ugoira.i.pximg.net/mock/${id}_ugoira1920x1080.zip`,
          mime_type: "image/jpeg",
          frames: [
            { file: "000000.jpg", delay: 60 },
            { file: "000001.jpg", delay: 60 },
          ],
        },
      })
    );
  });

  // ── GET /api/next?url=… (pagination) ──────────────────────────────────
  const nextFails = options.nextFails ?? false;
  await page.route(/\/api\/next(\?|$)/, (route) => {
    // Record BEFORE the failure branch so specs can assert the request
    // count even when the continuation 429s (the bounded-requests
    // assertion needs to see failed attempts too).
    const url = new URL(route.request().url());
    mocks.nextCalls.push({ url: url.searchParams.get("url") });
    if (nextFails) {
      route.fulfill(json({ error: "rate limited" }, 429));
      return;
    }
    route.fulfill(json(nextBatch));
  });

  // ── GET /api/img?url=… (image proxy → 1x1 PNG; ugoira zip for frames) ──
  await page.route(/\api\/img(\?|$)/, (route) => {
    mocks.imgCalls++;
    const url = new URL(route.request().url());
    const target = url.searchParams.get("url") ?? "";
    if (imgFailOnce && target.includes(imgFailOnce) && !mocks.imgFailures.includes(target)) {
      // Fail exactly once so the spec can exercise the retry button.
      mocks.imgFailures.push(target);
      route.fulfill({ status: 500, contentType: "text/plain", body: "boom" });
      return;
    }
    if (target.includes("img-zip-ugoira")) {
      // A real minimal zip with two 1x1 "frames" so fflate + canvas
      // playback actually run in the test.
      route.fulfill({
        status: 200,
        contentType: "application/zip",
        body: Buffer.from(UGOIRA_ZIP_B64, "base64"),
      });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(ONE_PX_PNG_BASE64, "base64"),
    });
  });

  return mocks;
}
