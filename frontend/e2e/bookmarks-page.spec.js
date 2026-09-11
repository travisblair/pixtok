import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { gotoApp, expectMainFeedCount, switchFeedViaDrawer } from "./fixtures/ui-helpers.js";

test.describe("Bookmarks page", () => {
  test("tag pills filter the page; unbookmark removes the work", async ({ page }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Bookmarks");
    await expect(page.locator(".feed-card")).toHaveCount(6, { timeout: 15000 });

    // Tag pill (tag-one from the tags endpoint) is a TOGGLE: no
    // separate All pill — tapping the active folder clears the filter.
    const tagPill = page.locator(".mode-pill", { hasText: "tag-one" });
    await expect(tagPill).toBeVisible();

    // Selecting the tag reloads page 0 with tag=tag-one.
    await tagPill.click();
    await expect(page.locator(".feed-card")).toHaveCount(6, { timeout: 15000 });
    expect(mocks.bookmarkCalls.at(-1)).toEqual({ tag: "tag-one", offset: 0 });

    // Unbookmark removes the work from the page.
    await page.locator(".feed-card").first().locator(".like-btn").click();
    await expect(page.locator(".feed-card")).toHaveCount(5, { timeout: 15000 });
    expect(mocks.unlikeCalls.length).toBeGreaterThan(0);

    // Clear the filter: re-tap the active tag.
    await tagPill.click();
    await expect(page.locator(".feed-card")).toHaveCount(6, { timeout: 15000 });
    expect(mocks.bookmarkCalls.at(-1)).toEqual({ tag: "", offset: 0 });
  });

  test("Private pill switches to the app-API private pile (pixtok likes)", async ({ page }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await switchFeedViaDrawer(page, "Bookmarks");
    await expect(page.locator(".feed-card")).toHaveCount(6, { timeout: 15000 });

    // Switch to Private: the app-API passthrough feed loads, and the
    // web-page tag pills (public-only folders) disappear.
    await page.locator(".mode-pill", { hasText: "Private" }).click();
    await expect(page.locator(".feed-card")).toHaveCount(6, { timeout: 15000 });
    expect(mocks.bookmarkPrivateCalls).toHaveLength(1);
    await expect(page.locator(".mode-pill", { hasText: "tag-one" })).toHaveCount(0);

    // Back to Public reloads the web-page feed (offset 0, no tag).
    await page.locator(".mode-pill", { hasText: "Public" }).click();
    await expect(page.locator(".feed-card")).toHaveCount(6, { timeout: 15000 });
    expect(mocks.bookmarkCalls.at(-1)).toEqual({ tag: "", offset: 0 });
  });
});
