// Regression: closing a related stack that sits OVER the search layer
// must restore the search feed's images. Reported: "when I close a
// stack on the search page, all the images on the search page go
// black."
import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeFeedOf } from "./fixtures/mock-data.js";
import { gotoApp, openDrawer } from "./fixtures/ui-helpers.js";

async function openSearch(page) {
  await openDrawer(page);
  await page.locator(".drawer-item", { hasText: "Search" }).click();
  await expect(page.locator(".search-input")).toBeVisible();
}

async function runQuery(page, q) {
  await page.locator(".search-input").fill(q);
  await page.locator(".search-form button[type=submit]").click();
  await expect(page.locator(".search-related-row")).toBeVisible();
}

test("closing a stack over search restores the search images", async ({
  page,
}) => {
  await setupApiMocks(page, { relatedBatch: makeFeedOf(8, 3001) });
  await gotoApp(page);
  await openSearch(page);
  await runQuery(page, "summer swimsuit");

  const firstCardImg = page
    .locator(".search-screen .feed-card")
    .first()
    .locator("img");

  // Search results land with real image srcs.
  await expect
    .poll(() => firstCardImg.getAttribute("src"))
    .toMatch(/\/api\/img/);

  // Open a related stack from the first result.
  await page
    .locator(".search-screen .feed-card")
    .first()
    .locator(".card-overlay")
    .click();
  await expect(page.locator(".related-view")).toHaveCount(1);

  // Close the stack.
  await page.locator(".related-view .related-back").click();
  await expect(page.locator(".related-view")).toHaveCount(0);

  // The search feed's images must come back (not stay black/unloaded).
  await expect
    .poll(() => firstCardImg.getAttribute("src"))
    .toMatch(/\/api\/img/);
});
