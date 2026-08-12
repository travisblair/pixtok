import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeFeedOf } from "./fixtures/mock-data.js";
import { gotoApp, expectMainFeedCount, settle } from "./fixtures/ui-helpers.js";

test.describe("Related-view navigation stack", () => {
  test("tapping a card pushes a related view anchored on that card", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page, {
      relatedBatch: makeFeedOf(8, 3001),
    });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const firstTitle = await page
      .locator(".feed-card")
      .first()
      .locator(".card-title")
      .textContent();

    await page
      .locator(".feed-card")
      .first()
      .locator(".card-overlay")
      .click();

    const rv = page.locator(".related-view");
    await expect(rv).toBeVisible();

    // Anchor + 8 related
    await expect(rv.locator(".feed-card")).toHaveCount(9);
    // Anchor is the tapped image
    await expect(rv.locator(".feed-card").first().locator(".card-title")).toHaveText(
      firstTitle.trim()
    );
    await expect.poll(() => mocks.relatedCalls.length).toBe(1);
    expect(mocks.relatedCalls[0].id).toBe(1);
  });

  test("tapping inside a related view stacks another, with back popping cleanly", async ({
    page,
  }) => {
    await setupApiMocks(page, { relatedBatch: makeFeedOf(8, 3001) });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".feed-card").first().locator(".card-overlay").click();
    await expect(page.locator(".related-view")).toHaveCount(1);

    // Tap the SECOND card inside the related view (the anchor is first)
    const rv1 = page.locator(".related-view").first();
    await rv1.locator(".feed-card").nth(1).locator(".card-overlay").click();
    await expect(page.locator(".related-view")).toHaveCount(2);

    // The new view stacks on top (z-index 51 > 50)
    const z1 = await page
      .locator(".related-view")
      .first()
      .evaluate((el) => getComputedStyle(el).zIndex);
    const z2 = await page
      .locator(".related-view")
      .nth(1)
      .evaluate((el) => getComputedStyle(el).zIndex);
    expect(Number(z2)).toBeGreaterThan(Number(z1));

    // Back pops one level, back again returns to the main feed
    await page.locator(".related-view").nth(1).locator(".related-back").click();
    await expect(page.locator(".related-view")).toHaveCount(1);
    await page.locator(".related-back").first().click();
    await expect(page.locator(".related-view")).toHaveCount(0);
    await expectMainFeedCount(page, 30);
  });

  test("back from a related view restores the main feed scroll position", async ({
    page,
  }) => {
    await setupApiMocks(page, { relatedBatch: makeFeedOf(8, 3001) });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Scroll down 3 viewports, tap the visible card
    await page.evaluate(() => {
      const el = document.querySelector(".feed-container");
      el.scrollTop = 3 * el.clientHeight;
    });
    await settle(500);
    const scrollBefore = await page.evaluate(
      () => document.querySelector(".feed-container").scrollTop
    );
    expect(scrollBefore).toBeGreaterThan(0);

    const visibleCard = page.locator(".feed-card").nth(3);
    await visibleCard.locator(".card-overlay").click();
    await expect(page.locator(".related-view")).toBeVisible();

    await page.locator(".related-back").click();
    await expect(page.locator(".related-view")).toHaveCount(0);

    const scrollAfter = await page.evaluate(
      () => document.querySelector(".feed-container").scrollTop
    );
    expect(scrollAfter).toBe(scrollBefore);
  });
});
