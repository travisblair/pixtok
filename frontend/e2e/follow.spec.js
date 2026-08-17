import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { gotoApp, expectMainFeedCount } from "./fixtures/ui-helpers.js";

test.describe("Follow button", () => {
  test("card rows show the small follow toggle", async ({ page }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Every strip card carries a follow toggle next to the artist name.
    const card = page.locator(".feed-card").first();
    await expect(card.locator(".card-artist .follow-btn.small")).toBeVisible();

    // Tap → POST follow → flips to Following; tap again → unfollow.
    await card.locator(".card-artist .follow-btn.small").click();
    await expect(card.locator(".card-artist .follow-btn.small")).toHaveText("✓", { timeout: 5000 });
    expect(mocks.followCalls.length).toBe(1);

    await card.locator(".card-artist .follow-btn.small").click();
    await expect(card.locator(".card-artist .follow-btn.small")).toHaveText("+", { timeout: 5000 });
    expect(mocks.unfollowCalls.length).toBe(1);
  });

  test("artist page header shows the full follow button", async ({ page }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Open the first card's artist page.
    await page.locator(".feed-card").first().locator(".card-artist a").click();
    await expect(page.locator(".artist-view")).toBeVisible();

    const btn = page.locator(".artist-view .follow-btn:not(.small)");
    await expect(btn).toHaveText("Follow", { timeout: 5000 });
    // Let the layer's 250ms slide-in finish — mid-animation the button
    // is off-viewport and unstable.
    await page.waitForTimeout(500);
    await btn.click();
    await expect(btn).toHaveText("Following");
    expect(mocks.followCalls.length).toBe(1);
  });
});
