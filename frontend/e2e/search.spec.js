// Search screen e2e — page-1 popular strip + related tags must be
// visible after a fresh search and stay reachable when scrolling
// (regression: mandatory scroll-snap in the search feed pinned every
// rest position to a card top, clipping the meta rows behind the
// header — "tags hidden under the pills").
import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
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

function searchScrollTop(page) {
  return page.evaluate(
    () => document.querySelector(".search-screen .feed-container").scrollTop
  );
}

async function scrollSearchBy(page, delta) {
  await page.evaluate((d) => {
    document
      .querySelector(".search-screen .feed-container")
      .scrollTo({ top: d, behavior: "instant" });
  }, delta);
  // Let any snap/layout settle.
  await page.waitForTimeout(300);
}

test("a fresh search shows the popular strip and related tags at the top", async ({
  page,
}) => {
  const mocks = await setupApiMocks(page);
  await gotoApp(page);
  await openSearch(page);
  await runQuery(page, "summer swimsuit");

  await expect(page.locator(".search-popular-strip")).toBeVisible();
  await expect(page.locator(".search-popular-item").first()).toBeVisible();
  await expect(page.locator(".search-related-row")).toBeVisible();
  await expect(page.locator(".search-related-pill").first()).toHaveText(
    "#tag-one"
  );
  await expect(page.locator(".search-screen .feed-card").first()).toBeVisible();
  expect(mocks.searchCalls.length).toBe(1);
  expect(mocks.searchCalls[0]).toMatchObject({ word: "summer swimsuit" });
  // Site-faithful params: full tag match + mode=all (verified live crawl).
  expect(mocks.searchCalls[0].s_mode).toBe("s_tag_full");
  expect(mocks.searchCalls[0].mode).toBe("all");
  // Results start at the top — the meta rows are fully visible, not
  // clipped behind the header.
  expect(await searchScrollTop(page)).toBe(0);
  const related = await page.locator(".search-related-row").boundingBox();
  const container = await page
    .locator(".search-screen .feed-container")
    .boundingBox();
  expect(related.y).toBeGreaterThanOrEqual(container.y);
});

test("scrolling down and back keeps the tags reachable (no snap lock)", async ({
  page,
}) => {
  const mocks = await setupApiMocks(page);
  await gotoApp(page);
  await openSearch(page);
  await runQuery(page, "summer swimsuit");

  // Scroll one card down — tags scroll away with the content.
  const container = await page
    .locator(".search-screen .feed-container")
    .boundingBox();
  await scrollSearchBy(page, container.height);
  expect(Math.round(await searchScrollTop(page))).toBe(Math.round(container.height));
  // Fully above the container's visible top edge (clipped out).
  let related = await page.locator(".search-related-row").boundingBox();
  expect(related.y + related.height).toBeLessThanOrEqual(container.y);

  // Scroll back up — the tags must come back (mandatory snap used to
  // yank the scroll position back to card 1's top, making this
  // region unreachable).
  await scrollSearchBy(page, 0);
  related = await page.locator(".search-related-row").boundingBox();
  expect(related.y).toBeGreaterThanOrEqual(container.y);
  expect(Math.round(await searchScrollTop(page))).toBe(0);
});

test("a fresh re-search while scrolled deep resets to the top", async ({
  page,
}) => {
  const mocks = await setupApiMocks(page);
  await gotoApp(page);
  await openSearch(page);
  await runQuery(page, "summer swimsuit");

  // Scroll a couple of cards deep, then re-search via a filter change
  // in the Filters modal (Oldest).
  const container = await page
    .locator(".search-screen .feed-container")
    .boundingBox();
  await scrollSearchBy(page, container.height * 2);
  expect(await searchScrollTop(page)).toBeGreaterThan(container.height);

  await page.locator(".filter-button", { hasText: "Filters" }).click();
  await page.locator(".modal-dialog .mode-pill", { hasText: "Oldest" }).click();
  await expect(page.locator(".search-related-row")).toBeVisible();
  await expect
    .poll(async () => mocks.searchCalls.length)
    .toBeGreaterThanOrEqual(2);
  expect(mocks.searchCalls.at(-1).order).toBe("date");
  // Back at the top — the new page-1 meta rows are visible.
  expect(Math.round(await searchScrollTop(page))).toBe(0);
});

test("tapping a related tag re-runs the search with that tag", async ({
  page,
}) => {
  const mocks = await setupApiMocks(page);
  await gotoApp(page);
  await openSearch(page);
  await runQuery(page, "summer swimsuit");

  await page
    .locator(".search-related-pill", { hasText: "#tag-two" })
    .click();
  await expect(page.locator(".search-input")).toHaveValue("tag-two");
  await expect
    .poll(async () => mocks.searchCalls.length)
    .toBeGreaterThanOrEqual(2);
  expect(mocks.searchCalls.at(-1).word).toBe("tag-two");
  // Fresh search → still at the top with the tags visible.
  await expect(page.locator(".search-related-row")).toBeVisible();
  expect(Math.round(await searchScrollTop(page))).toBe(0);
});

test("filters apply live: work type, AI hide, and a custom date range", async ({
  page,
}) => {
  const mocks = await setupApiMocks(page);
  await gotoApp(page);
  await openSearch(page);
  await runQuery(page, "summer swimsuit");

  await page.locator(".filter-button", { hasText: "Filters" }).click();
  await expect(page.locator(".modal-dialog")).toBeVisible();

  // Illustrations only → type=illust
  await page
    .locator(".modal-dialog .mode-pill", { hasText: "Illustrations only" })
    .click();
  await expect
    .poll(async () => mocks.searchCalls.length)
    .toBeGreaterThanOrEqual(2);
  expect(mocks.searchCalls.at(-1).type).toBe("illust");

  // AI hide → ai_type=1
  await page.locator(".modal-dialog .mode-pill", { hasText: "Hide" }).click();
  await expect
    .poll(() => mocks.searchCalls.at(-1).ai_type)
    .toBe("1");

  // Custom posting date → scd/sce ride the request
  await page.locator(".modal-dialog .mode-pill", { hasText: "Custom" }).click();
  await expect(page.locator('input[aria-label="From date"]')).toBeVisible();
  await page.locator('input[aria-label="From date"]').fill("2026-06-01");
  await page.locator('input[aria-label="To date"]').fill("2026-06-30");
  await expect
    .poll(() => mocks.searchCalls.at(-1).scd)
    .toBe("2026-06-01");
  expect(mocks.searchCalls.at(-1).sce).toBe("2026-06-30");

  // Badge reflects the three active filters (workType, aiType, dateMode).
  await expect(page.locator(".filter-badge")).toHaveText("3");

  // Reset returns everything to defaults in one more search.
  await page.locator(".modal-dialog .mode-pill", { hasText: "Reset" }).click();
  await expect(page.locator(".filter-badge")).toHaveCount(0);
  await expect
    .poll(() => mocks.searchCalls.at(-1))
    .toMatchObject({
      type: "all",
      ai_type: "0",
      scd: "",
      sce: "",
      order: "date_d",
    });

  // Ugoira only rides the work-type endpoint switch (verified live:
  // /illustrations?type=ugoira is pixiv's own ugoira search).
  await page.locator(".modal-dialog .mode-pill", { hasText: "Ugoira only" }).click();
  await expect
    .poll(() => mocks.searchCalls.at(-1).type)
    .toBe("ugoira");
});

test("switching to Artists runs the user search", async ({ page }) => {
  const mocks = await setupApiMocks(page);
  await gotoApp(page);
  await openSearch(page);
  await runQuery(page, "mock-artist");

  await page.locator(".search-pills .mode-pill", { hasText: "Artists" }).click();
  await expect(page.locator(".search-user-row")).toHaveCount(2);
  expect(mocks.searchUsersCalls.at(-1)).toMatchObject({
    nick: "mock-artist",
    p: 1,
  });
});
