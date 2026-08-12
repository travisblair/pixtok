import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { PIXEL_DATA_URI } from "./fixtures/mock-data.js";
import { gotoApp, expectMainFeedCount, settle } from "./fixtures/ui-helpers.js";

test.describe("Image unload / preload window", () => {
  test("scrolling far past a card unloads its images; scrolling back reloads them", async ({
    page,
  }) => {
    await setupApiMocks(page); // 30 single-page cards
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const firstImg = page.locator(".feed-card").first().locator("img").first();

    // Visible at top: real proxied src
    await expect
      .poll(() => firstImg.getAttribute("src"))
      .toContain("/api/img?url=");

    // Scroll ~12 viewports down — card 1 is far above the 6-viewport window.
    await page.evaluate(() => {
      const el = document.querySelector(".feed-container");
      el.scrollTop = 12 * el.clientHeight;
    });
    // Unload hysteresis is 500ms + IO callback timing; wait generously.
    await settle(1500);

    // Unloaded: src swapped to the 1px placeholder data URI
    await expect.poll(() => firstImg.getAttribute("src")).toBe(PIXEL_DATA_URI);

    // Scroll back to the top
    await page.evaluate(() => {
      document.querySelector(".feed-container").scrollTop = 0;
    });
    await settle(1000);

    // Reloaded (immediate activation for visible cards)
    await expect
      .poll(() => firstImg.getAttribute("src"))
      .toContain("/api/img?url=");
  });

  test("cards near the scroll position stay loaded", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // 9 viewports down: card 1 is 8V above the viewport — clearly outside
    // the 6V window (8V keeps it off the exact boundary; 7V puts the card
    // edge right ON the margin where browsers disagree on intersection).
    await page.evaluate(() => {
      const el = document.querySelector(".feed-container");
      el.scrollTop = 9 * el.clientHeight;
    });
    await settle(1500);

    // The visible card (index 9) has a real src; card 1 does not.
    const visibleImg = page.locator(".feed-card").nth(9).locator("img").first();
    await expect
      .poll(() => visibleImg.getAttribute("src"))
      .toContain("/api/img?url=");
    const earlyImg = page.locator(".feed-card").nth(1).locator("img").first();
    await expect
      .poll(() => earlyImg.getAttribute("src"))
      .toBe(PIXEL_DATA_URI);
  });
});
