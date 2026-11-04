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

    // Production pace: 2 works = 2 × (unlike + like) + 1600ms.
    await expect(page.locator(".toast")).toContainText(
      "Moved 2 works to private",
      { timeout: 20000 }
    );

    // The completion toast is STICKY — it must survive the 8s auto-hide
    // window (the pile only updates on reload).
    await page.waitForTimeout(8500);
    await expect(page.locator(".toast")).toContainText(
      "Moved 2 works to private"
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

  test("a deleted work (404 on re-add) is skipped and the queue keeps going", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page, { likeGone: [9502] });
    await openPublicBookmarks(page);

    const bar = page.locator(".selection-bar");
    await bar.getByRole("button", { name: "Select", exact: true }).click();
    await page.locator(".feed-card").nth(0).click();
    await page.locator(".feed-card").nth(1).click();
    await page.locator(".feed-card").nth(2).click();
    await expect(bar).toContainText("3 selected");

    await bar.locator(".mode-pill", { hasText: "Move to private" }).click();

    // The 404 does NOT stop the queue: 2 works move, 1 is reported
    // skipped, and the completion toast is sticky.
    await expect(page.locator(".toast")).toContainText(
      "Moved 2 works to private — 1 deleted work skipped",
      { timeout: 20000 }
    );

    // Wire order: 9502's unlike+like both ran, and the queue carried on
    // to 9503 — proving a deleted work no longer bricks a batch.
    expect(mocks.likeUnlikeEvents).toEqual([
      "unlike:9501",
      "like:9501",
      "unlike:9502",
      "like:9502",
      "unlike:9503",
      "like:9503",
    ]);

    // No failure modal — skips are not failures.
    await expect(page.locator(".modal-dialog")).toHaveCount(0);
    await expect(page.locator(".feed-card")).toHaveCount(6);
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
