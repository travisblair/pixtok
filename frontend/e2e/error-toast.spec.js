import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { gotoApp, expectMainFeedCount, switchFeedViaDrawer } from "./fixtures/ui-helpers.js";

test.describe("Error toast", () => {
  test("a failed request shows a red top toast; tap dismisses instantly", async ({
    page,
  }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Shadow the bookmarks route with a 502 (later routes win).
    await page.route(/(?<!\/api)\/api\/bookmarks(\?|$)/, (route) => {
      route.fulfill({
        status: 502,
        contentType: "text/plain",
        body: "upstream error",
      });
    });

    await switchFeedViaDrawer(page, "Bookmarks");

    const toast = page.locator(".error-toast");
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toHaveText("Request failed (502)");

    // Tap dismisses immediately — no waiting out the 2s timer.
    await toast.click();
    await expect(toast).toHaveCount(0);
  });

  test("the toast auto-hides after 2 seconds", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.route(/(?<!\/api)\/api\/bookmarks(\?|$)/, (route) => {
      route.fulfill({
        status: 500,
        contentType: "text/plain",
        body: "boom",
      });
    });

    await switchFeedViaDrawer(page, "Bookmarks");
    await expect(page.locator(".error-toast")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".error-toast")).toHaveCount(0, {
      timeout: 5000,
    });
  });
});
