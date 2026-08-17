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

    // Pills: All active, tag-one from the tags endpoint.
    const allPill = page.locator(".mode-pill", { hasText: "All" });
    await expect(allPill).toHaveClass(/active/);
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

    // Back to All: offset 0 with no tag.
    await allPill.click();
    await expect(page.locator(".feed-card")).toHaveCount(6, { timeout: 15000 });
    expect(mocks.bookmarkCalls.at(-1)).toEqual({ tag: "", offset: 0 });
  });
});
