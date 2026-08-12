import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeIllust, makeFeed, makeFeedOf } from "./fixtures/mock-data.js";
import {
  gotoApp,
  expectMainFeedCount,
  switchFeedViaDrawer,
  scrollFeedToBottom,
  scrollFeedByViewports,
  feedScrollTop,
  settle,
} from "./fixtures/ui-helpers.js";

test.describe("Home feed (street)", () => {
  test("renders 30 street cards with no mode pills on Home", async ({ page }) => {
    const mocks = await setupApiMocks(page); // default streetBatch: 30
    await gotoApp(page);

    await expectMainFeedCount(page, 30);

    // First street call POSTs an empty JSON object (page 1)
    await expect.poll(() => mocks.streetBodies).toEqual(["{}"]);

    // Pills live on the Ranking tab now — Home has none
    await expect(page.locator(".mode-selector")).toHaveCount(0);
  });

  test("street feed paginates: POSTs the nextParams cursor back", async ({ page }) => {
    const mocks = await setupApiMocks(page, {
      streetBatch: makeFeedOf(30, 1, '{"page":2}'),
      streetNextBatch: makeFeedOf(10, 5000, null),
    });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await scrollFeedToBottom(page);
    await expectMainFeedCount(page, 40);

    await expect.poll(() => mocks.streetBodies).toEqual(['{}', '{"page":2}']);
  });

  test("overlapping street pages are deduped by id", async ({ page }) => {
    // Page 2 deliberately re-injects ids 5-8 (Pixiv's personalized feed
    // does this for real — the cursor carries the overlap).
    const mocks = await setupApiMocks(page, {
      streetBatch: makeFeedOf(8, 1, '{"page":2}'),
      streetNextBatch: makeFeed([
        ...makeFeedOf(4, 5).illusts, // ids 5-8: duplicates of page 1
        ...makeFeedOf(6, 100).illusts, // ids 100-105: fresh
      ]),
    });
    await gotoApp(page);
    await expectMainFeedCount(page, 8);

    await scrollFeedToBottom(page);
    // 8 + 6 fresh = 14. Without dedupe it would be 18.
    await expectMainFeedCount(page, 14);
    await expect.poll(() => mocks.streetBodies).toEqual(['{}', '{"page":2}']);
  });

  test("infinite scroll prefetches well before the sentinel is reached", async ({ page }) => {
    const mocks = await setupApiMocks(page, {
      streetBatch: makeFeedOf(8, 1, '{"page":2}'),
      streetNextBatch: makeFeedOf(10, 5000, null),
    });
    await gotoApp(page);
    await expectMainFeedCount(page, 8);

    // 8 cards ≈ 8 viewports. Scroll only 5 viewports down — with the
    // 2400px rootMargin the next page must ALREADY be prefetched.
    await scrollFeedByViewports(page, 5);
    await expectMainFeedCount(page, 18);
    await expect.poll(() => mocks.streetBodies).toEqual(['{}', '{"page":2}']);

    // And we are demonstrably NOT at the bottom yet.
    const pos = await feedScrollTop(page);
    const { scrollHeight, clientHeight } = await page.evaluate(() => {
      const el = document.querySelector(".feed-container");
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    expect(scrollHeight - clientHeight - pos).toBeGreaterThan(1500);
  });

  test("card images load through the /api/img proxy", async ({ page }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // First card is visible → its page should be loaded via the proxy
    await expect
      .poll(async () =>
        page.locator(".feed-card").first().locator("img").first().getAttribute("src")
      )
      .toContain("/api/img?url=");

    await expect.poll(() => mocks.imgCalls).toBeGreaterThan(0);
  });

  test("Discover feed infinite-scrolls: appends nextBatch when sentinel visible", async ({ page }) => {
    const mocks = await setupApiMocks(page, {
      recsBatch: makeFeedOf(5, 2001, "/api/next?cursor=mock1"),
      nextBatch: makeFeedOf(10, 4001, null),
    });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Discover");
    await expectMainFeedCount(page, 5);

    // Sentinel far below 5 cards — no pagination yet
    expect(mocks.nextCalls).toHaveLength(0);

    // Reach the bottom: sentinel enters the 200px rootMargin → loadMore
    await scrollFeedToBottom(page);
    await expectMainFeedCount(page, 15);
    await expect.poll(() => mocks.nextCalls.length).toBe(1);
    expect(mocks.nextCalls[0].url).toContain("cursor=mock1");
  });
});

test.describe("Ranking tab", () => {
  test("shows two pill rows and loads the daily ranking", async ({ page }) => {
    const mocks = await setupApiMocks(page); // default topBatch: 30, next_url null
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Ranking");
    await expectMainFeedCount(page, 30);

    // Default: content=All, mode=Daily → app-API mode "day".
    await expect.poll(() => mocks.topModes).toEqual(["day"]);
    await expect(page.locator(".content-pills .mode-pill.active")).toHaveText("All");
    await expect(page.locator(".mode-selector .mode-pill.active")).toHaveText("Daily");
    // The full site mode set is present in the second row.
    for (const label of ["Daily", "Weekly", "Monthly", "Rookie", "Original", "AI", "Male", "Female"]) {
      await expect(
        page.getByRole("button", { name: label, exact: true })
      ).toBeVisible();
    }
  });

  test("R18 pill swaps the mode row and refetches with mode=day_r18", async ({ page }) => {
    const r18Batch = makeFeed([
      makeIllust({ id: 9001, title: "禁断の果実" }),
      makeIllust({ id: 9002, title: "夜の帳" }),
      makeIllust({ id: 9003, title: "秘密の花園" }),
      makeIllust({ id: 9004, title: "甘い罠" }),
    ]);
    const mocks = await setupApiMocks(page, { topByMode: { day_r18: r18Batch } });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Ranking");
    await expectMainFeedCount(page, 30);

    await page.locator(".content-pills .mode-pill", { hasText: "R18" }).click();

    await expect.poll(() => mocks.topModes).toEqual(["day", "day_r18"]);
    await expect(page.locator(".content-pills .mode-pill.active")).toHaveText("R18");

    // Mode row swapped to the R-18 variants.
    const r18Modes = await page.locator(".mode-selector .mode-pill").allTextContents();
    expect(r18Modes).toEqual(["Daily", "Weekly", "Male", "Female"]);

    // Feed content replaced by the r18 batch.
    await expectMainFeedCount(page, 4);
    await expect(
      page.locator(".feed-card").first().locator(".card-title")
    ).toHaveText("禁断の果実");
  });

  test("weekly pill refetches with mode=week", async ({ page }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Ranking");
    await expectMainFeedCount(page, 30);

    await page.locator(".mode-selector .mode-pill", { hasText: "Weekly" }).click();

    await expect.poll(() => mocks.topModes).toEqual(["day", "week"]);
    await expectMainFeedCount(page, 30);
  });

  test("does NOT paginate when next_url is null", async ({ page }) => {
    const mocks = await setupApiMocks(page); // topBatch next_url: null
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Ranking");
    await expectMainFeedCount(page, 30);

    await scrollFeedToBottom(page);
    await settle(1000);

    // Sentinel is visible at the bottom but there is nothing to load:
    // no /api/next call, no appended cards.
    expect(mocks.nextCalls).toHaveLength(0);
    await expectMainFeedCount(page, 30);
  });

  test("paginates via next_url when the ranking has more pages", async ({ page }) => {
    const page1 = makeFeed(makeFeedOf(30, 1).illusts, "https://app-api.pixiv.net/v1/illust/ranking?offset=30");
    const mocks = await setupApiMocks(page, { topBatch: page1 }); // nextBatch: 10 more
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Ranking");
    await expectMainFeedCount(page, 30);

    await scrollFeedToBottom(page);
    await settle(1500);

    expect(mocks.nextCalls.length).toBe(1);
    await expectMainFeedCount(page, 40);
  });
});

test.describe("Newest tab", () => {
  test("loads the newest firehose with All/R18 pills", async ({ page }) => {
    const mocks = await setupApiMocks(page); // newestBatch: 20, next_url set
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Newest");
    await expectMainFeedCount(page, 20);

    await expect.poll(() => mocks.newestCalls).toEqual([{ r18: false, lastId: "" }]);
    await expect(page.locator(".content-pills .mode-pill.active")).toHaveText("All");

    // R18 pill refetches the adult stream.
    await page.locator(".content-pills .mode-pill", { hasText: "R18" }).click();
    await expect.poll(() => mocks.newestCalls.length).toBe(2);
    expect(mocks.newestCalls[1]).toEqual({ r18: true, lastId: "" });
    await expect(page.locator(".content-pills .mode-pill.active")).toHaveText("R18");
  });

  test("paginates via the lastId cursor in next_url", async ({ page }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Newest");
    await expectMainFeedCount(page, 20);

    await scrollFeedToBottom(page);
    await settle(1500);

    // The continuation fetched /api/newest with the cursor from next_url.
    expect(mocks.newestCalls.length).toBe(2);
    expect(mocks.newestCalls[1].lastId).toBe("5000");
    await expectMainFeedCount(page, 30); // 20 + 10
  });
});

test.describe("Illustrations (top page) tab", () => {
  test("loads the top-page grid with All/R18 pills and no pagination", async ({ page }) => {
    const mocks = await setupApiMocks(page); // topIllustBatch: 30, next_url null
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Illustrations");
    await expectMainFeedCount(page, 30);

    await expect.poll(() => mocks.topIllustModes).toEqual(["all"]);

    await page.locator(".content-pills .mode-pill", { hasText: "R18" }).click();
    await expect.poll(() => mocks.topIllustModes).toEqual(["all", "r18"]);

    // Fixed grid — scrolling never paginates.
    await scrollFeedToBottom(page);
    await settle(1000);
    expect(mocks.nextCalls).toHaveLength(0);
    await expectMainFeedCount(page, 30);
  });
});
