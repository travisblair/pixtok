import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import {
  gotoApp,
  expectMainFeedCount,
  scrollFeedByViewports,
} from "./fixtures/ui-helpers.js";

/**
 * Immersive full-bleed (pinch-spread on strip/stack cards).
 *
 * Native pinch can't be driven through Playwright's mouse API, so the
 * specs dispatch real TouchEvents in the page (Chromium has the Touch
 * constructor). The card listens at .feed-card; events bubble.
 */

async function pinch(page, selector, fromSpread, toSpread) {
  await page.evaluate(
    ({ selector, fromSpread, toSpread }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no element for ${selector}`);
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const makeTouch = (id, x) =>
        new Touch({
          identifier: id,
          target: el,
          clientX: x,
          clientY: cy,
          screenX: x,
          screenY: cy,
          pageX: x,
          pageY: cy,
          radiusX: 2,
          radiusY: 2,
          force: 1,
        });
      const fire = (type, xs, changed = xs) =>
        el.dispatchEvent(
          new TouchEvent(type, {
            touches: xs.map((x, i) => makeTouch(i, x)),
            changedTouches: changed.map((x, i) => makeTouch(i, x)),
            bubbles: true,
            cancelable: true,
            composed: true,
          })
        );

      const spread = (s) => [cx - s / 2, cx + s / 2];
      fire("touchstart", spread(fromSpread));
      fire("touchmove", spread(toSpread));
      fire("touchend", [], spread(toSpread));
    },
    { selector, fromSpread, toSpread }
  );
}

async function openFirstStack(page) {
  await page.locator(".feed-card").first().locator(".card-overlay").click();
  await expect(page.locator(".related-view")).toBeVisible();
}

test.describe("Immersive full-bleed", () => {
  test("pinch-spread hides overlay, action stack and feed header; restore icon brings them back", async ({
    page,
  }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const card = page.locator(".feed-card").first();
    const header = page.locator(".header-bar");
    await expect(card.locator(".card-overlay")).toBeVisible();
    await expect(card.locator(".card-right-stack")).toBeVisible();
    await expect(header).toBeVisible();

    await pinch(page, ".feed-card", 100, 400);

    await expect(card).toHaveClass(/immersive/);
    await expect(card.locator(".card-overlay")).toBeHidden();
    await expect(card.locator(".card-right-stack")).toBeHidden();
    await expect(header).toBeHidden();
    const restore = card.locator(".card-immersive-restore");
    await expect(restore).toBeVisible();

    // Small, dim, bottom-right of the card.
    const cardBox = await card.boundingBox();
    const restoreBox = await restore.boundingBox();
    expect(restoreBox.x).toBeGreaterThan(cardBox.x + cardBox.width / 2);
    expect(restoreBox.y).toBeGreaterThan(cardBox.y + cardBox.height / 2);

    await restore.click();
    await expect(card).not.toHaveClass(/immersive/);
    await expect(card.locator(".card-overlay")).toBeVisible();
    await expect(card.locator(".card-right-stack")).toBeVisible();
    await expect(header).toBeVisible();
    await expect(restore).toHaveCount(0);
  });

  test("pinch-in restores, and a tap while immersive restores without opening a stack", async ({
    page,
  }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const card = page.locator(".feed-card").first();

    await pinch(page, ".feed-card", 100, 400);
    await expect(card).toHaveClass(/immersive/);

    await pinch(page, ".feed-card", 400, 100);
    await expect(card).not.toHaveClass(/immersive/);
    await expect(card.locator(".card-overlay")).toBeVisible();

    // Immersive again, then a single tap on the image: restore ONLY.
    await pinch(page, ".feed-card", 100, 400);
    await expect(card).toHaveClass(/immersive/);
    await card.locator(".card-image").click();
    await expect(card).not.toHaveClass(/immersive/);
    await expect(card.locator(".card-overlay")).toBeVisible();
    await expect(page.locator(".related-view")).toHaveCount(0);

    // A tap AFTER restore opens the stack as usual.
    await card.locator(".card-overlay").click();
    await expect(page.locator(".related-view")).toBeVisible();
  });

  test("scrolling the feed cancels immersive", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const card = page.locator(".feed-card").first();
    await pinch(page, ".feed-card", 100, 400);
    await expect(card).toHaveClass(/immersive/);

    await scrollFeedByViewports(page, 1);
    await expect(card).not.toHaveClass(/immersive/);
    await expect(page.locator(".header-bar")).toBeVisible();
  });

  test("related-stack layer chrome (Back/✕, depth badge, hint) hides while immersive", async ({
    page,
  }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);
    await openFirstStack(page);

    const layer = page.locator(".related-view").first();
    await expect(layer.locator(".related-header-left")).toBeVisible();
    await expect(layer.locator(".stack-depth-badge")).toBeVisible();

    const stackCard = layer.locator(".feed-card").first();
    await pinch(page, ".related-view .feed-card", 100, 400);
    await expect(stackCard).toHaveClass(/immersive/);
    await expect(layer.locator(".related-header-left")).toBeHidden();
    await expect(layer.locator(".stack-depth-badge")).toBeHidden();
    await expect(layer.locator(".stack-hint")).toBeHidden();

    // Pinch-in restores the layer chrome; Back still works.
    await pinch(page, ".related-view .feed-card", 400, 100);
    await expect(layer.locator(".related-header-left")).toBeVisible();
    await expect(layer.locator(".stack-depth-badge")).toBeVisible();
    await layer.locator(".related-back").click();
    await expect(page.locator(".related-view")).toHaveCount(0);

    // The main feed header was never touched by a stack-layer immersive.
    await expect(page.locator(".header-bar")).toBeVisible();
  });
});
