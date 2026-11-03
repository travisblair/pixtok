import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import {
  gotoApp,
  expectMainFeedCount,
  switchFeedViaDrawer,
} from "./fixtures/ui-helpers.js";

/**
 * Bookmarks tab → PUBLIC pile → move works to private. The queue calls
 * the existing /api/illust/:id/{unlike,like} routes serially: delete
 * (v1) then re-add (v2 restrict=private), back-to-back per work, paced
 * 1600ms BETWEEN works. The spec asserts the mocked WIRE ORDER and
 * counts — no test seam for pacing (2 works ≈ 5s, acceptable).
 */

async function openPublicBookmarks(page) {
  await gotoApp(page);
  await expectMainFeedCount(page, 30);
  await switchFeedViaDrawer(page, "Bookmarks");
  await expect(page.locator(".feed-card")).toHaveCount(6, { timeout: 15000 });
}

test.describe("Bookmarks move to private", () => {
  test("select mode moves loaded works with one delete+add pair each, no live removal", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page);
    await openPublicBookmarks(page);

    // Selection chrome only exists on the public bookmarks pile.
    const bar = page.locator(".selection-bar");
    await expect(bar.getByRole("button", { name: "Select", exact: true })).toBeVisible();
    await bar.getByRole("button", { name: "Select", exact: true }).click();

    // Every rendered strip card gets a checkbox overlay.
    await expect(page.locator(".card-select-box")).toHaveCount(6);

    // Select all / deselect all operate on the loaded works.
    await bar.getByRole("button", { name: "Select all", exact: true }).click();
    await expect(bar).toContainText("6 selected");
    await bar.getByRole("button", { name: "Deselect all" }).click();
    await expect(bar).toContainText("0 selected");

    // Tap two cards: selection toggles, no stack opens (no recs POST).
    await page.locator(".feed-card").nth(0).click();
    await page.locator(".feed-card").nth(1).click();
    await expect(bar).toContainText("2 selected");

    await bar.locator(".mode-pill", { hasText: "Move to private" }).click();
    await expect(page.locator(".move-progress")).toContainText("Moving");

    // Production pace: 2 works = 2 × (unlike + 1600ms + like) + 1600ms.
    await expect(page.locator(".toast")).toContainText(
      "Moved 2 works to private",
      { timeout: 20000 }
    );

    // Per work: delete BEFORE re-add; works strictly one at a time.
    expect(mocks.likeUnlikeEvents).toEqual([
      "unlike:9501",
      "like:9501",
      "unlike:9502",
      "like:9502",
    ]);

    // No live removal — moved works drop off on the next refresh.
    await expect(page.locator(".feed-card")).toHaveCount(6);
    await expect(bar.getByRole("button", { name: "Select", exact: true })).toBeVisible();
  });

  test("a failed delete stops the queue and the modal reports failures + cancellations", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page, { unlikeFails: [9501] });
    await openPublicBookmarks(page);

    const bar = page.locator(".selection-bar");
    await bar.getByRole("button", { name: "Select", exact: true }).click();
    await bar.getByRole("button", { name: "Select all", exact: true }).click();
    await bar.locator(".mode-pill", { hasText: "Move to private" }).click();

    // Stop-on-failure: exactly one unlike attempt, no re-add, no retry.
    const modal = page.locator(".modal-dialog");
    await expect(modal).toBeVisible({ timeout: 15000 });
    expect(mocks.unlikeCalls).toEqual([{ id: 9501 }]);
    expect(mocks.likeCalls).toEqual([]);

    await expect(modal).toContainText("9501");
    await expect(modal).toContainText("delete failed");
    await expect(modal).toContainText("9502");
    await expect(modal).toContainText("cancelled");

    // Cards are untouched by the run.
    await page.locator(".modal-x").click();
    await expect(page.locator(".feed-card")).toHaveCount(6);
  });
});
