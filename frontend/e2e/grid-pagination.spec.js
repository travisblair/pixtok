import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeFeedOf } from "./fixtures/mock-data.js";
import {
  gotoApp,
  scrollFeedToBottom,
  settle,
} from "./fixtures/ui-helpers.js";

/**
 * Grid pagination regression tests.
 *
 * The grid's cells are ~10x shorter than strip cards, so the strip's
 * 2400px prefetch margin would sit far inside the first grid page
 * (30 cells ≈ 1300px) — auto-firing pages on boot and, after any
 * FAILED load, re-firing forever (loading flips → observer
 * re-subscribes → initial callback fires → another request → 429 →
 * repeat until pixiv rate-limits the whole home network).
 *
 * Fix: (1) canLoad includes the screen's load-error signal, so a
 * failure stops auto-pagination and waits for the retry button;
 * (2) grid mode uses a ~400px margin — enough prefetch for ~3 rows of
 * cells, but the boot-time sentinel distance (~500px) stays outside it.
 */

const GRID_CELLS = ".feed-container .grid-cell";

test.describe("Grid pagination", () => {
  test("does not chain-load pages on boot: one request until the user scrolls", async ({ page }) => {
    const mocks = await setupApiMocks(page, {
      feedViewMode: "grid",
      streetBatch: makeFeedOf(30, 1, '{"page":2}'),
      streetNextBatch: makeFeedOf(30, 5000, null),
    });
    await gotoApp(page);
    await page.locator(GRID_CELLS).first().waitFor();

    // No user scroll yet — the boot page must be the ONLY request.
    await settle(2000);
    expect(mocks.streetBodies).toEqual(["{}"]);
    await expect(page.locator(GRID_CELLS)).toHaveCount(30);
  });

  test("scrolling near the bottom loads exactly one more page", async ({ page }) => {
    const mocks = await setupApiMocks(page, {
      feedViewMode: "grid",
      streetBatch: makeFeedOf(30, 1, '{"page":2}'),
      streetNextBatch: makeFeedOf(30, 5000, null),
    });
    await gotoApp(page);
    await page.locator(GRID_CELLS).first().waitFor();

    await scrollFeedToBottom(page);
    await expect(page.locator(GRID_CELLS)).toHaveCount(60, { timeout: 10_000 });
    await settle(1500);

    // Exactly one continuation — no chain-firing (the next page's
    // sentinel sits outside the 400px margin after the append).
    expect(mocks.streetBodies).toEqual(["{}", '{"page":2}']);
  });

  test("a failing next page does NOT auto-retry: bounded requests + retry button", async ({ page }) => {
    const mocks = await setupApiMocks(page, {
      feedViewMode: "grid",
      streetBatch: makeFeedOf(30, 1, '{"page":2}'),
      streetNextBatch: makeFeedOf(30, 5000, null),
      streetNextFails: true,
    });
    await gotoApp(page);
    await page.locator(GRID_CELLS).first().waitFor();

    await scrollFeedToBottom(page);
    await expect(
      page.locator(".feed-sentinel .mode-pill", { hasText: "Couldn't load" })
    ).toBeVisible();

    // The failure must STOP the loop: page 1 + exactly one failed
    // continuation, no more after a long settle.
    await settle(2500);
    expect(mocks.streetBodies).toEqual(["{}", '{"page":2}']);
    await expect(page.locator(GRID_CELLS)).toHaveCount(30);
  });

  test("the retry button recovers after a one-off failure", async ({ page }) => {
    const mocks = await setupApiMocks(page, {
      feedViewMode: "grid",
      streetBatch: makeFeedOf(30, 1, '{"page":2}'),
      streetNextBatch: makeFeedOf(30, 5000, null),
      streetNextFailOnce: true,
    });
    await gotoApp(page);
    await page.locator(GRID_CELLS).first().waitFor();

    await scrollFeedToBottom(page);
    await expect(
      page.locator(".feed-sentinel .mode-pill", { hasText: "Couldn't load" })
    ).toBeVisible();

    await page.locator(".feed-sentinel .mode-pill").click();
    await expect(page.locator(GRID_CELLS)).toHaveCount(60, { timeout: 10_000 });
    await settle(1500);
    expect(mocks.streetBodies).toEqual(["{}", '{"page":2}', '{"page":2}']);
  });
});

test.describe("Layer pagination failure guards (same storm, other screens)", () => {
  test("artist page grid: a failing next page stops and shows the retry button", async ({ page }) => {
    const mocks = await setupApiMocks(page, {
      artistViewMode: "grid",
      userBatch: { illusts: makeFeedOf(6, 4001).illusts, next_url: "/api/next?url=artist2" },
      nextFails: true,
    });
    await gotoApp(page);
    await page.locator(".feed-card").first().locator(".card-artist a").click();
    await expect(page.locator(".artist-view .grid-cell")).toHaveCount(6);

    // Scroll the artist grid to the bottom → continuation fails once.
    await scrollFeedToBottom(page, ".artist-view .feed-container");
    await expect(
      page.locator(".artist-view .feed-sentinel .mode-pill")
    ).toBeVisible();

    await settle(2500);
    // Bounded: exactly one continuation attempt, no storm.
    expect(mocks.nextCalls).toHaveLength(1);
    await expect(page.locator(".artist-view .grid-cell")).toHaveCount(6);
  });

  test("related stack (strip): a failing next page stops and shows the retry button", async ({ page }) => {
    const mocks = await setupApiMocks(page, {
      relatedBatch: {
        illusts: makeFeedOf(8, 3001).illusts,
        next_url: "/api/next?url=related2",
      },
      nextFails: true,
    });
    await gotoApp(page);
    await page.locator(".feed-card").first().click();
    // Wait for the FULL related page (1 anchor + 8 works) before
    // scrolling — scrolling against a half-rendered container leaves
    // the sentinel out of range and the test times out waiting for the
    // failure button.
    await expect(page.locator(".related-view .feed-card")).toHaveCount(9);

    await scrollFeedToBottom(page, ".related-view .feed-container");
    await expect(
      page.locator(".related-view .feed-sentinel .mode-pill")
    ).toBeVisible();

    await settle(2500);
    expect(mocks.nextCalls).toHaveLength(1);
  });
});
