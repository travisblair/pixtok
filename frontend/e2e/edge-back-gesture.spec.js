import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeMultiPageIllust, makeFeedOf } from "./fixtures/mock-data.js";
import { gotoApp, expectMainFeedCount } from "./fixtures/ui-helpers.js";

/**
 * Edge-back gesture: touch down within the left 24px and drag right to
 * pop the top layer (iOS push-navigation convention). The native
 * multi-page sliders keep their horizontal drags — an edge start ON a
 * horizontally-scrollable card arms nothing.
 */

/**
 * Synthesize a left-edge swipe: touchstart at fromX, a few touchmoves
 * up to toX, touchend. When `on` is given the sequence dispatches on
 * that element (so the gesture sees it as the touch target); otherwise
 * it dispatches on document.body (the "empty area" case).
 */
async function edgeSwipe(page, { fromX = 5, toX = 140, steps = 8, on = null } = {}) {
  await page.evaluate(
    ({ fromX, toX, steps, sel }) => {
      const doc = document;
      const mk = (x, y) =>
        new Touch({
          identifier: 1,
          target: doc.body,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          radiusX: 2,
          radiusY: 2,
          force: 1,
        });
      const fire = (target, type, touches, changed) =>
        target.dispatchEvent(
          new TouchEvent(type, {
            touches,
            changedTouches: changed,
            bubbles: true,
            cancelable: true,
          })
        );
      const target = sel ? document.querySelector(sel) : doc.body;
      const y = window.innerHeight / 2;
      fire(target, "touchstart", [mk(fromX, y)], [mk(fromX, y)]);
      for (let i = 1; i <= steps; i++) {
        const x = fromX + ((toX - fromX) * i) / steps;
        fire(target, "touchmove", [mk(x, y)], [mk(x, y)]);
      }
      fire(target, "touchend", [], [mk(toX, y)]);
    },
    { fromX, toX, steps, sel: on }
  );
}

test.describe("Edge-back gesture", () => {
  test("a rightward edge swipe pops the top related layer", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".feed-card").first().locator(".card-image").click();
    await expect(page.locator(".related-view")).toBeVisible();

    await edgeSwipe(page);

    await expect(page.locator(".related-view")).toHaveCount(0, {
      timeout: 5000,
    });
    await expectMainFeedCount(page, 30);
  });

  test("a rightward edge swipe pops an open artist page", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".feed-card").first().locator(".card-artist a").click();
    await expect(page.locator(".artist-view")).toBeVisible();

    await edgeSwipe(page);

    await expect(page.locator(".artist-view")).toHaveCount(0, {
      timeout: 5000,
    });
    await expectMainFeedCount(page, 30);
  });

  test("a multi-page slider in the edge zone keeps its drag — no pop", async ({
    page,
  }) => {
    const batch = {
      illusts: [makeMultiPageIllust(1, 3), ...makeFeedOf(29, 2).illusts],
      next_url: null,
    };
    await setupApiMocks(page, { streetBatch: batch });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Open the multi-page work: its card is the related view's anchor.
    await page.locator(".feed-card").first().locator(".card-image").first().click();
    await expect(page.locator(".related-view")).toBeVisible();
    const slider = page.locator(".related-view .card-pages").first();
    await expect(slider).toBeVisible();
    // Sanity: the anchor really is a horizontally-scrollable slider.
    const overflows = await slider.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1
    );
    expect(overflows).toBe(true);

    // Edge swipe STARTING ON the slider must not pop the layer.
    await edgeSwipe(page, { on: ".related-view .card-pages" });
    await expect(page.locator(".related-view")).toBeVisible();
    await page.waitForTimeout(400); // longer than the close animation
    await expect(page.locator(".related-view")).toBeVisible();

    // The same swipe from a non-slider spot pops normally.
    await edgeSwipe(page);
    await expect(page.locator(".related-view")).toHaveCount(0, {
      timeout: 5000,
    });
  });

  test("an edge swipe pops ONE layer at a time — never the whole stack", async ({
    page,
  }) => {
    await setupApiMocks(page, { relatedBatch: makeFeedOf(8, 3001) });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Depth 1, then depth 2 (tap the second card inside the first view).
    await page.locator(".feed-card").first().locator(".card-image").click();
    await expect(page.locator(".related-view")).toHaveCount(1);
    await page
      .locator(".related-view")
      .first()
      .locator(".feed-card")
      .nth(1)
      .locator(".card-image")
      .click();
    await expect(page.locator(".related-view")).toHaveCount(2);

    // First swipe pops exactly the top level.
    await edgeSwipe(page);
    await expect(page.locator(".related-view")).toHaveCount(1, {
      timeout: 5000,
    });
    await page.waitForTimeout(450); // > 350ms pop cooldown

    // Second swipe pops the last level back to the feed.
    await edgeSwipe(page);
    await expect(page.locator(".related-view")).toHaveCount(0, {
      timeout: 5000,
    });
    await expectMainFeedCount(page, 30);
  });

  test("three levels pop one at a time back to the feed", async ({ page }) => {
    await setupApiMocks(page, { relatedBatch: makeFeedOf(8, 3001) });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Depth 1 → 2 → 3 (tap a related card in the top view each time).
    await page.locator(".feed-card").first().locator(".card-image").click();
    await expect(page.locator(".related-view")).toHaveCount(1);
    for (let depth = 2; depth <= 3; depth++) {
      await page
        .locator(".related-view")
        .last()
        .locator(".feed-card")
        .nth(1)
        .locator(".card-image")
        .click();
      await expect(page.locator(".related-view")).toHaveCount(depth);
    }

    // Each swipe pops exactly ONE level (cooldown cleared between).
    for (const want of [2, 1, 0]) {
      await edgeSwipe(page);
      await expect(page.locator(".related-view")).toHaveCount(want, {
        timeout: 5000,
      });
      await page.waitForTimeout(450); // > 350ms pop cooldown
    }
    await expectMainFeedCount(page, 30);
  });

  test("two rapid swipes within the cooldown pop only one layer", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page, { relatedBatch: makeFeedOf(8, 3001) });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".feed-card").first().locator(".card-image").click();
    await expect(page.locator(".related-view")).toHaveCount(1);
    await page
      .locator(".related-view")
      .first()
      .locator(".feed-card")
      .nth(1)
      .locator(".card-image")
      .click();
    await expect(page.locator(".related-view")).toHaveCount(2);

    // Two swipes back-to-back (both inside the 350ms cooldown): the
    // second must be suppressed — one layer popped, not two.
    await edgeSwipe(page);
    await edgeSwipe(page);
    await page.waitForTimeout(500); // give any errant second pop time
    await expect(page.locator(".related-view")).toHaveCount(1, {
      timeout: 5000,
    });

    // The breadcrumbs tell the same story: one pop, one suppression.
    const suppressed = mocks.logEvents.filter(
      (e) => e.scope === "gesture" && e.msg === "pop-suppressed"
    );
    expect(suppressed.length).toBeGreaterThanOrEqual(1);
  });

  test("an edge swipe with no layers open does nothing", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await edgeSwipe(page);
    await page.waitForTimeout(400);

    await expectMainFeedCount(page, 30);
    await expect(page.locator(".related-view")).toHaveCount(0);
    await expect(page.locator(".artist-view")).toHaveCount(0);
  });
});
