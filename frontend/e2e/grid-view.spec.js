import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeIllust, makeFeedOf } from "./fixtures/mock-data.js";
import {
  gotoApp,
  expectMainFeedCount,
  openDrawer,
} from "./fixtures/ui-helpers.js";

/**
 * Grid view (Settings → View toggles).
 *
 * Default is strip everywhere — the grid must be an opt-in that layers
 * (stacks, recs modal) never inherit.
 */

async function openSettings(page) {
  await openDrawer(page);
  await page.locator(".drawer-item", { hasText: "Settings" }).click();
  await expect(page.locator(".modal-dialog")).toBeVisible();
}

async function setViewRow(page, rowTestId, mode) {
  await page
    .locator(`[data-testid="${rowTestId}"] .mode-pill`, { hasText: mode })
    .click();
}

test.describe("Grid view", () => {
  test("feeds toggle to grid, replace the strip, and persist across reload", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30); // strip is the default

    await openSettings(page);
    await setViewRow(page, "feed-view-row", "Grid");

    const mainFeed = page.locator(".feed-container").first();
    await expect(mainFeed.locator(".grid-cell")).toHaveCount(30);
    await expect(mainFeed.locator(".feed-card")).toHaveCount(0);
    // No text overlays in the grid (settled: thumbnails only).
    await expect(mainFeed.locator(".card-title")).toHaveCount(0);

    await page.locator(".modal-x").click();
    await expect(page.locator(".modal-dialog")).toHaveCount(0);

    // The toggle lives in the backend prefs DB — a reload reads it back.
    await page.reload();
    await expect(
      page.locator(".feed-container").first().locator(".grid-cell")
    ).toHaveCount(30);
  });

  test("tapping a cell opens a related stack — layers always render strip", async ({ page }) => {
    const mocks = await setupApiMocks(page, { feedViewMode: "grid" });
    await gotoApp(page);
    await expect(
      page.locator(".feed-container").first().locator(".grid-cell")
    ).toHaveCount(30);

    await page.locator(".grid-cell").first().click();
    await expect(page.locator(".related-view .feed-card").first()).toBeVisible();
    await expect.poll(() => mocks.relatedCalls.length).toBe(1);
    expect(mocks.relatedCalls[0].id).toBe(1);
  });

  test("a heart from a grid cell syncs to the same work in the strip", async ({ page }) => {
    const mocks = await setupApiMocks(page, { feedViewMode: "grid" });
    await gotoApp(page);
    const cell = page.locator(".grid-cell").first();
    await expect(cell.locator(".grid-cell-heart")).toHaveText("🤍");

    await cell.locator(".grid-cell-heart").click();
    await expect(cell.locator(".grid-cell-heart")).toHaveText("❤️");
    await expect.poll(() => mocks.likeCalls.length).toBe(1);
    expect(mocks.likeCalls[0].id).toBe(1);

    // Back to strip (Settings → View): the same work's heart is filled —
    // hearts are shared store state, not per-renderer state.
    await openSettings(page);
    await setViewRow(page, "feed-view-row", "Strip");
    await page.locator(".modal-x").click();
    await expect(
      page.locator(".feed-container").first().locator(".feed-card").first().locator(".like-btn")
    ).toHaveText("❤️");
  });

  test("artist page honors its own toggle while feeds stay strip", async ({ page }) => {
    const mocks = await setupApiMocks(page, { artistViewMode: "grid" });
    await gotoApp(page);
    await expectMainFeedCount(page, 30); // feeds stay strip

    await page.locator(".feed-card").first().locator(".card-artist a").click();
    await expect(page.locator(".artist-view")).toBeVisible();
    await expect(page.locator(".artist-view .grid-cell")).toHaveCount(6);
    await expect(page.locator(".artist-view .feed-card")).toHaveCount(0);
    await expect.poll(() => mocks.userCalls.length).toBe(1);

    // The main feed underneath is still strip.
    await expectMainFeedCount(page, 30);
  });

  test("a ugoira cell plays from its badge without opening a stack", async ({ page }) => {
    const ugoira = makeIllust({ id: 55, type: "ugoira" });
    const mocks = await setupApiMocks(page, {
      feedViewMode: "grid",
      streetBatch: {
        illusts: [ugoira, ...makeFeedOf(29, 56).illusts],
        next_url: null,
      },
    });
    await gotoApp(page);
    const cell = page.locator(".grid-cell").first();
    await expect(cell.locator(".grid-cell-ugoira")).toBeVisible();

    await cell.locator(".grid-cell-ugoira").click();
    // Playback fetches the animation metadata; no stack is pushed.
    await expect.poll(() => mocks.ugoiraCalls.length).toBeGreaterThan(0);
    expect(mocks.relatedCalls).toHaveLength(0);
  });
});
