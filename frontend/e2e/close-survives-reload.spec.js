// Regression: closing a layer must survive a reload that lands DURING the
// 250ms slide-out animation. iOS jetsam kills pages mid-transition; the
// debounced (500ms) snapshot save never fires, so the stale snapshot used
// to resurrect the artist page on the next boot — Back → reload → artist
// again, forever, until Safari killed the tab for repeated failures.
// The fix: close actions write the snapshot SYNCHRONOUSLY.
import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeFeedOf, makeIllust } from "./fixtures/mock-data.js";
import { gotoApp } from "./fixtures/ui-helpers.js";

test("artist close survives an immediate reload (no layer resurrection)", async ({
  page,
}) => {
  const batch = makeFeedOf(5, 1);
  const mocks = await setupApiMocks(page, {
    streetBatch: batch,
    topBatch: batch,
  });
  await gotoApp(page);
  await expect(page.locator(".feed-card").first()).toBeVisible();

  // Open the artist page from the first card.
  await page
    .locator(".feed-card")
    .first()
    .locator(".card-artist a")
    .click();
  await expect(page.locator(".artist-view")).toBeVisible();

  // Let the debounced snapshot record the artist page (600ms > 500ms).
  await page.waitForTimeout(700);

  // Click Back, then reload IMMEDIATELY — inside the 260ms close window,
  // before the debounced save would ever fire.
  await page.locator(".artist-view .related-back").click();
  await page.reload();

  // The artist page must NOT come back.
  await expect(page.locator(".feed-card").first()).toBeVisible();
  await expect(page.locator(".artist-view")).toHaveCount(0);

  // The main feed still restored (snapshot did its job elsewhere).
  await expect(page.locator(".feed-card")).not.toHaveCount(0);
});

test("stack close survives an immediate reload", async ({ page }) => {
  const batch = makeFeedOf(5, 1);
  const mocks = await setupApiMocks(page, {
    streetBatch: batch,
    topBatch: batch,
  });
  await gotoApp(page);
  await expect(page.locator(".feed-card").first()).toBeVisible();

  // Open a related stack from the first card.
  await page.locator(".feed-card").first().locator(".card-image").click();
  await expect(page.locator(".related-view")).toBeVisible();
  await page.waitForTimeout(700); // let the debounced save capture the stack

  // Back + immediate reload inside the close window.
  await page.locator(".related-view .related-back").first().click();
  await page.reload();

  await expect(page.locator(".feed-card").first()).toBeVisible();
  await expect(page.locator(".related-view")).toHaveCount(0);
});
