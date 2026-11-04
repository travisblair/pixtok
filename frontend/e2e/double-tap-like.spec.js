import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { gotoApp, expectMainFeedCount } from "./fixtures/ui-helpers.js";

/**
 * Double-tap to like (touch-only).
 *
 * Playwright's mouse API can't produce touch taps, so the specs dispatch
 * real TouchEvents in the page. Desktop clicks stay immediate — covered
 * by the existing specs, which must keep passing untouched.
 */

async function tap(page, selector, times = 1, { offsetPx = 0 } = {}) {
  await page.evaluate(
    ({ selector, times, offsetPx }) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`no element for ${selector}`);
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const makeTouch = (tapIndex) => {
        // A real double-tap never lands on the same pixel twice; simulate
        // finger drift on the second tap so the between-taps slop path
        // is exercised.
        const x0 = x + (tapIndex > 0 ? offsetPx : 0);
        return new Touch({
          identifier: 1,
          target: el,
          clientX: x0,
          clientY: y,
          screenX: x0,
          screenY: y,
          pageX: x0,
          pageY: y,
          radiusX: 2,
          radiusY: 2,
          force: 1,
        });
      };
      const fire = (type, active, changed) =>
        el.dispatchEvent(
          new TouchEvent(type, {
            touches: active,
            changedTouches: changed,
            bubbles: true,
            cancelable: true,
            composed: true,
          })
        );
      for (let i = 0; i < times; i++) {
        const t = makeTouch(i);
        fire("touchstart", [t], [t]);
        fire("touchend", [], [t]);
      }
    },
    { selector, times, offsetPx }
  );
}

test.describe("Double-tap to like", () => {
  test("strip card: double-tap likes, double-tap again unlikes, stack never opens", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const card = page.locator(".feed-card").first();
    const heart = card.locator(".like-btn");
    await expect(heart).toHaveText("🤍");

    await tap(page, ".feed-card .card-image", 2);

    await expect(heart).toHaveText("❤️");
    expect(mocks.likeCalls).toHaveLength(1);
    expect(mocks.likeCalls[0].id).toBe(1);
    expect(mocks.unlikeCalls).toHaveLength(0);
    await expect(page.locator(".related-view")).toHaveCount(0);
    // Transient confirmation appears, then removes itself.
    await expect(card.locator(".heart-flash")).toHaveCount(1);
    await expect(card.locator(".heart-flash")).toHaveCount(0, { timeout: 3000 });

    // The in-flight lock must be released before the unlike double-tap.
    await page.waitForTimeout(50);
    await tap(page, ".feed-card .card-image", 2);
    await expect(heart).toHaveText("🤍");
    expect(mocks.unlikeCalls).toHaveLength(1);
    expect(mocks.likeCalls).toHaveLength(1);
    await expect(page.locator(".related-view")).toHaveCount(0);
  });

  test("strip card: double-tap with ~20px finger drift still likes, no stack, no already-open toast", async ({
    page,
  }) => {
    // Regression: real double-taps land 10-30px apart. The old 10px
    // between-taps slop rejected them — the first single opened the
    // stack and the second pushed the same work ("already open").
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const card = page.locator(".feed-card").first();
    const heart = card.locator(".like-btn");
    await expect(heart).toHaveText("🤍");

    await tap(page, ".feed-card .card-image", 2, { offsetPx: 20 });

    await expect(heart).toHaveText("❤️");
    expect(mocks.likeCalls).toHaveLength(1);
    expect(mocks.unlikeCalls).toHaveLength(0);
    await expect(page.locator(".related-view")).toHaveCount(0);
    await expect(page.locator(".toast")).toHaveCount(0);
  });

  test("one touch tap still opens the stack — deferred, not immediate", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await tap(page, ".feed-card .card-image", 1);
    // Still inside the ~500ms double-tap window: nothing opened yet.
    await page.waitForTimeout(100);
    await expect(page.locator(".related-view")).toHaveCount(0);
    expect(mocks.likeCalls).toHaveLength(0);

    // The deferred single tap then opens the stack.
    await expect(page.locator(".related-view")).toBeVisible();
  });

  test("grid cell: double-tap likes through App's onLike wiring (recs flow fires)", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page, { feedViewMode: "grid" });
    await gotoApp(page);
    const grid = page.locator(".feed-container").first();
    await expect(grid.locator(".grid-cell")).toHaveCount(30);

    const cell = grid.locator(".grid-cell").first();
    const heart = cell.locator(".grid-cell-heart");
    await expect(heart).toHaveText("🤍");

    await tap(page, ".feed-container .grid-cell", 2);

    await expect(heart).toHaveText("❤️");
    expect(mocks.likeCalls).toHaveLength(1);
    expect(mocks.likeCalls[0].id).toBe(1);
    await expect(page.locator(".related-view")).toHaveCount(0);
    await expect(cell.locator(".heart-flash")).toHaveCount(1);

    // Same side effects as the heart button: App fetches per-work recs
    // and shows the recommendations toast.
    await expect.poll(() => mocks.workRecsCalls.length).toBe(1);
    expect(mocks.workRecsCalls[0].id).toBe(1);
    await expect(page.locator(".toast")).toContainText("Recommendations for");

    await page.waitForTimeout(50);
    await tap(page, ".feed-container .grid-cell", 2);
    await expect(heart).toHaveText("🤍");
    expect(mocks.unlikeCalls).toHaveLength(1);
  });

  test("a late WebKit-style synthetic click after a single tap doesn't re-open the stack", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await tap(page, ".feed-card .card-image", 1);
    await expect(page.locator(".related-view")).toBeVisible({ timeout: 8000 });
    expect(mocks.relatedCalls).toHaveLength(1);

    // WebKit fires its synthetic click AFTER the deferred single's
    // stack-open render — past any fixed suppression window. The old
    // time-window code handled it and re-opened the same work ("already
    // open" toast). The click budget must absorb it whenever it lands.
    await page.waitForTimeout(700); // past CLICK_SUPPRESS_MS (600)
    await page.evaluate(() => {
      const el = document.querySelector(".feed-card .card-image");
      if (!el) throw new Error("no card image");
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });
    await page.waitForTimeout(400);

    // The bug produced an "already open" toast from the double-open;
    // the absorbed click must produce NO toast at all.
    await expect(page.locator(".toast")).toHaveCount(0);
    expect(mocks.relatedCalls).toHaveLength(1); // still just the one stack
  });
});
