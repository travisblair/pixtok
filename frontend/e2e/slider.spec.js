import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeFeed, makeMultiPageIllust, makeFeedOf } from "./fixtures/mock-data.js";
import { gotoApp, expectMainFeedCount, settle } from "./fixtures/ui-helpers.js";

test.describe("Multi-page slider", () => {
  test("shows a 1/N counter and advances it on horizontal scroll", async ({
    page,
  }) => {
    // First card is a 4-page manga; the rest fill the feed.
    const batch = makeFeed([
      makeMultiPageIllust(1, 4),
      ...makeFeedOf(29, 2).illusts,
    ]);
    await setupApiMocks(page, { streetBatch: batch });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const firstCard = page.locator(".feed-card").first();
    await expect(firstCard.locator(".page-counter")).toHaveText("1/4");
    await expect(firstCard.locator(".card-pages")).toBeVisible();

    // Swipe right-to-left: scroll the horizontal slider one page width
    await firstCard.locator(".card-pages").evaluate((el) => {
      el.scrollLeft = el.clientWidth;
    });
    await expect
      .poll(() => firstCard.locator(".page-counter").textContent())
      .toBe("2/4");

    // One more page
    await firstCard.locator(".card-pages").evaluate((el) => {
      el.scrollLeft = 2 * el.clientWidth;
    });
    await expect
      .poll(() => firstCard.locator(".page-counter").textContent())
      .toBe("3/4");
  });

  test("slider pages are exactly viewport width", async ({ page }) => {
    const batch = makeFeed([
      makeMultiPageIllust(1, 3),
      ...makeFeedOf(29, 2).illusts,
    ]);
    await setupApiMocks(page, { streetBatch: batch });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const viewport = page.viewportSize();
    const firstCard = page.locator(".feed-card").first();
    const pages = firstCard.locator(".card-page");
    await expect(pages).toHaveCount(3);

    for (let i = 0; i < 3; i++) {
      const box = await pages.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(Math.round(box.width)).toBe(viewport.width);
    }
  });

  test("single-page cards render no slider", async ({ page }) => {
    await setupApiMocks(page); // default single-page batch
    await gotoApp(page);
    await expectMainFeedCount(page, 30);
    await expect(page.locator(".card-pages")).toHaveCount(0);
  });

  test("long sliders keep a tight ±1 image window, offloading visited pages", async ({
    page,
  }) => {
    const batch = makeFeed([
      makeMultiPageIllust(1, 120),
      ...makeFeedOf(9, 2).illusts,
    ]);
    await setupApiMocks(page, { streetBatch: batch });
    await gotoApp(page);
    await expectMainFeedCount(page, 10);

    const firstCard = page.locator(".feed-card").first();
    const slider = firstCard.locator(".card-pages");
    const pageImg = (i) => slider.locator(".card-page").nth(i).locator("img");

    // Page 1: only the first two pages hold real image srcs; the rest are
    // the 1px placeholder (data:) — 120 decoded master1200s must never
    // exist at once.
    await expect(pageImg(0)).toHaveAttribute("src", /\/api\/img/);
    await expect(pageImg(1)).toHaveAttribute("src", /\/api\/img/);
    await expect(pageImg(2)).toHaveAttribute("src", /^data:/);

    // Jump to page 51: window is 50-52 (indexes 49-51); page 1 is
    // offloaded.
    await slider.evaluate((el) => {
      el.scrollLeft = 50 * el.clientWidth;
    });
    await expect
      .poll(() => firstCard.locator(".page-counter").textContent())
      .toBe("51/120");
    await expect(pageImg(0)).toHaveAttribute("src", /^data:/);
    await expect(pageImg(49)).toHaveAttribute("src", /\/api\/img/);
    await expect(pageImg(50)).toHaveAttribute("src", /\/api\/img/);
    await expect(pageImg(51)).toHaveAttribute("src", /\/api\/img/);
    await expect(pageImg(52)).toHaveAttribute("src", /^data:/);

    // Jump to page 101: 100-102 real; page 51 offloaded. Memory stays
    // bounded no matter how far the user swipes.
    await slider.evaluate((el) => {
      el.scrollLeft = 100 * el.clientWidth;
    });
    await expect
      .poll(() => firstCard.locator(".page-counter").textContent())
      .toBe("101/120");
    await expect(pageImg(50)).toHaveAttribute("src", /^data:/);
    await expect(pageImg(99)).toHaveAttribute("src", /\/api\/img/);
    await expect(pageImg(100)).toHaveAttribute("src", /\/api\/img/);
    await expect(pageImg(101)).toHaveAttribute("src", /\/api\/img/);
    await expect(pageImg(102)).toHaveAttribute("src", /^data:/);
  });
});
