import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeFeedOf } from "./fixtures/mock-data.js";
import { gotoApp, expectMainFeedCount, switchFeedViaDrawer } from "./fixtures/ui-helpers.js";

test.describe("Reload persistence", () => {
  test("tab and pills survive a reload; the feed refetches fresh", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page); // newestBatch: 20, next_url set
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Newest");
    await expectMainFeedCount(page, 20);
    await page.locator(".content-pills .mode-pill", { hasText: "R18" }).click();
    await expect.poll(() => mocks.newestCalls.length).toBe(2);

    // Let the 500ms snapshot debounce settle, then reload.
    await page.waitForTimeout(800);
    await page.reload();

    // Newest tab + R18 pill restored from the snapshot, but the FEED
    // refetches a fresh first page (a third /api/newest call) — feeds
    // are always new; only navigation + layers persist (user decision).
    await expectMainFeedCount(page, 20);
    await expect(page.locator(".content-pills .mode-pill.active")).toHaveText("R18");
    await expect(page.locator(".drawer-item.active")).toHaveText("Newest");
    await expect(page.locator(".drawer.open")).toHaveCount(0); // drawer closed
    expect(mocks.newestCalls.length).toBe(3);
  });

  test("an open artist page is restored after a reload", async ({ page }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Open an artist page from the first card.
    await page.locator(".feed-card").first().locator(".card-artist a").click();
    await expect(page.locator(".artist-view")).toBeVisible();
    await expect.poll(() => mocks.userCalls.length).toBe(1);

    await page.waitForTimeout(800); // snapshot debounce
    await page.reload();

    // Artist view remounts from the snapshot and refetches the works.
    await expect(page.locator(".artist-view")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".artist-name-badge")).toBeVisible();
    await expect.poll(() => mocks.userCalls.length).toBe(2);
  });

  test("the recs modal reopens after a reload", async ({ page }) => {
    const mocks = await setupApiMocks(page, {
      workRecsBatch: makeFeedOf(5, 2001),
    });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Like → toast → open the recs modal.
    await page.locator(".feed-card").first().locator(".like-btn").click();
    const toast = page.locator(".toast");
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await toast.click();
    await expect(page.locator(".recs-modal")).toBeVisible();
    await expect(page.locator(".recs-modal .feed-card")).toHaveCount(5);
    await expect.poll(() => mocks.workRecsCalls.length).toBe(1);

    // Snapshot settles, then the jetsam-style reload.
    await page.waitForTimeout(800);
    await page.reload();

    await expect(page.locator(".recs-modal")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".recs-modal .feed-card")).toHaveCount(5);
    await expect(page.locator(".recs-source")).toBeVisible();
    // No refetch — the modal's list came from the snapshot.
    expect(mocks.workRecsCalls.length).toBe(1);
    // Main feed underneath refetched fresh (feeds are never restored).
    await expectMainFeedCount(page, 30);
  });
});
