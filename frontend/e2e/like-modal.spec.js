import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeFeedOf, makeIllust } from "./fixtures/mock-data.js";
import { gotoApp, expectMainFeedCount } from "./fixtures/ui-helpers.js";

test.describe("Like → related-works modal (unified with the tap-stack)", () => {
  test("heart toggles and records the like/unlike POSTs", async ({ page }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const heart = page.locator(".feed-card").first().locator(".like-btn");
    await expect(heart).toHaveText("🤍");

    await heart.click();
    await expect(heart).toHaveText("❤️");
    await expect.poll(() => mocks.likeCalls.length).toBe(1);
    expect(mocks.likeCalls[0].id).toBe(1); // first mock illust id

    await heart.click();
    await expect(heart).toHaveText("🤍");
    await expect.poll(() => mocks.unlikeCalls.length).toBe(1);
  });

  test("like fetches PER-WORK recs (recommend/init); toast names the work and opens the modal", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page, {
      workRecsBatch: makeFeedOf(5, 2001),
    });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".feed-card").first().locator(".like-btn").click();

    // Toast appears after the per-work recs fetch resolves, naming the work
    const toast = page.locator(".toast");
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).toContainText("Recommendations for");

    // The request must hit the /recs route for the LIKED work (id 1) —
    // NOT the tap-stack's /related engine, and NOT the global feed.
    await expect.poll(() => mocks.workRecsCalls.length).toBe(1);
    expect(mocks.workRecsCalls[0].id).toBe(1);
    expect(mocks.relatedCalls.length).toBe(0);
    expect(mocks.recsCalls).toBe(0);

    await toast.click();

    const modal = page.locator(".recs-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator(".feed-card")).toHaveCount(5);
    // The source title is shown in the modal
    await expect(modal.locator(".recs-source")).toBeVisible();

    // Main feed is untouched — still 30 cards underneath
    await expectMainFeedCount(page, 30);
  });

  test("like state is shared: liking in the stack updates the main feed heart", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Tap the first card → stack opens
    await page.locator(".feed-card").first().locator(".card-overlay").click();
    await expect(page.locator(".related-view")).toBeVisible();

    // Like INSIDE the stack (the anchor card's heart)
    const stackHeart = page
      .locator(".related-view")
      .first()
      .locator(".feed-card")
      .first()
      .locator(".like-btn");
    await stackHeart.click();
    await expect(stackHeart).toHaveText("❤️");

    // Go back — the main feed card must show ❤️ too
    await page.locator(".related-back").click();
    await expect(page.locator(".related-view")).toHaveCount(0);
    await expect(
      page.locator(".feed-card").first().locator(".like-btn")
    ).toHaveText("❤️");
  });

  test("stack shows the depth badge", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".feed-card").first().locator(".card-overlay").click();
    await expect(page.locator(".stack-depth-badge")).toHaveText("1/10");

    // Second level
    await page
      .locator(".related-view .feed-card")
      .nth(1)
      .locator(".card-overlay")
      .click();
    await expect(page.locator(".stack-depth-badge").last()).toHaveText("2/10");
  });

  test("modal closes via ✕ and leaves the main feed intact", async ({
    page,
  }) => {
    await setupApiMocks(page, { workRecsBatch: makeFeedOf(5, 2001) });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".feed-card").first().locator(".like-btn").click();
    await page.locator(".toast").click();
    await expect(page.locator(".recs-modal")).toBeVisible();

    // NOTE: no backdrop-close assertion — the full-screen recs feed covers
    // the backdrop entirely (z-index 1 > backdrop), so by design the ✕ is
    // the close affordance and taps land on rec cards (pushing related
    // views), which is the intended drill-down behaviour.
    await page.locator(".recs-close").click();
    await expect(page.locator(".recs-modal")).toHaveCount(0);
    await expectMainFeedCount(page, 30);

    // Reopen via a different card; close again.
    await page
      .locator(".feed-card")
      .nth(1)
      .locator(".like-btn")
      .click();
    await page.locator(".toast").click();
    await expect(page.locator(".recs-modal")).toBeVisible();
    await page.locator(".recs-close").click();
    await expect(page.locator(".recs-modal")).toHaveCount(0);
    await expectMainFeedCount(page, 30);
  });

  test("like failure reverts the heart and shows no toast", async ({ page }) => {
    await setupApiMocks(page, { likeFails: true });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    const heart = page.locator(".feed-card").first().locator(".like-btn");
    await heart.click();

    // Optimistic flip happens, then reverts on the 500
    await expect(heart).toHaveText("🤍");
    await expect(page.locator(".toast")).toHaveCount(0);
  });

  test("toast wraps long titles full-width instead of clipping off-screen", async ({ page }) => {
    const longTitle =
      "超長いタイトルのイラストでトーストが折り返すことを確認するためのとてもとても長い作品名ですよ";
    const batch = {
      illusts: [makeIllust({ id: 1, title: longTitle }), ...makeFeedOf(29, 2).illusts],
      next_url: null,
    };
    await setupApiMocks(page, { streetBatch: batch });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".feed-card").first().locator(".like-btn").click();

    const toast = page.locator(".toast");
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).toContainText(longTitle);

    // Full-width bar: spans the viewport minus the 16px insets, and the
    // text WRAPS — a long title must not push the pill past either edge.
    const viewport = page.viewportSize();
    const box = await toast.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box.x)).toBe(16);
    expect(Math.round(box.x + box.width)).toBe(viewport.width - 16);
    // The button grows with its content, so a wrapped toast is TALLER than
    // one text line + its 24px vertical padding (≈45px) — two lines ≥ 66px.
    expect(box.height).toBeGreaterThan(60);
  });
});
