import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeFeed, makeFeedOf, makeIllust } from "./fixtures/mock-data.js";
import { gotoApp, expectMainFeedCount } from "./fixtures/ui-helpers.js";

test.describe("UX round", () => {
  test("close-all returns to the feed from any stack depth", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Push one level (tap first card)
    await page.locator(".feed-card").first().locator(".card-overlay").click();
    await expect(page.locator(".related-view")).toHaveCount(1);

    // Push a second level from a RELATED work (never the anchor)
    await page
      .locator(".related-view .feed-card")
      .nth(1)
      .locator(".card-overlay")
      .click();
    await expect(page.locator(".related-view")).toHaveCount(2);
    await expect(page.locator(".stack-depth-badge").last()).toHaveText("2/10");

    // Covered layer unloads its images; only the top layer loads.
    await expect(
      page.locator(".related-view").first().locator("img").first()
    ).toHaveAttribute("src", /^data:/);
    await expect(
      page.locator(".related-view").last().locator("img").first()
    ).toHaveAttribute("src", /\/api\/img/);

    // ✕ closes EVERYTHING (click the TOPMOST view's button — deeper
    // layers cover shallower ones)
    await page.locator(".close-all-btn").last().click();
    await expect(page.locator(".related-view")).toHaveCount(0);
    await expectMainFeedCount(page, 30);
  });

  test("stack refuses to reopen a work that's already open", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".feed-card").first().locator(".card-overlay").click();
    await expect(page.locator(".related-view")).toHaveCount(1);

    // Tap the ANCHOR itself inside the stack — must refuse.
    await page
      .locator(".related-view .feed-card")
      .first()
      .locator(".card-overlay")
      .click();
    await expect(page.locator(".toast")).toContainText("already open");
    await expect(page.locator(".related-view")).toHaveCount(1);
  });

  test("one-time hint coaches the first stack open, then stays gone", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // First open: push animation class + hint bubble.
    await page.locator(".feed-card").first().locator(".card-overlay").click();
    await expect(page.locator(".related-view")).toHaveClass(/enter/);
    await expect(page.locator(".stack-hint")).toBeVisible();
    await expect(page.locator(".stack-hint")).toContainText("Back returns you here");

    await page.locator(".stack-hint button").click();
    await expect(page.locator(".stack-hint")).toHaveCount(0);

    // Back (slide-out), reopen a different stack — no hint this time.
    await page.locator(".related-back").click();
    await expect(page.locator(".related-view")).toHaveCount(0);
    await page.locator(".feed-card").nth(1).locator(".card-overlay").click();
    await expect(page.locator(".related-view")).toHaveCount(1);
    await expect(page.locator(".stack-hint")).toHaveCount(0);
  });

  test("artist tap opens the artist's library", async ({ page }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".feed-card").first().locator(".card-artist a").click();

    await expect(page.locator(".artist-view")).toBeVisible();
    await expect.poll(() => mocks.userCalls.length).toBe(1);
    expect(mocks.userCalls[0].id).toBe(1001); // mock artist id (string→normalized)
    await expect(page.locator(".artist-view .feed-card")).toHaveCount(6);
    await expect(page.locator(".artist-name-badge")).toBeVisible();

    // Back returns to the main feed
    await page.locator(".artist-view .related-back").click();
    await expect(page.locator(".artist-view")).toHaveCount(0);
    await expectMainFeedCount(page, 30);
  });

  test("tapping another artist name inside an artist view swaps to that artist", async ({
    page,
  }) => {
    const mocks = await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Open the first artist (card 1 → user 1001).
    await page.locator(".feed-card").first().locator(".card-artist a").click();
    await expect(page.locator(".artist-view")).toBeVisible();
    await expect.poll(() => mocks.userCalls.length).toBe(1);

    // Tap a DIFFERENT artist's name on a card inside the view (user 5001).
    const swapLink = page
      .locator(".artist-view .feed-card")
      .first()
      .locator(".card-artist a");
    const swapName = (await swapLink.textContent()).trim();
    await swapLink.click();

    // The view must REMOUNT for the new artist: a fresh user-illusts
    // request with the NEW id, and the badge showing the NEW name.
    // Regression: the view used to reconcile in place, keeping the
    // previous artist's works under the new name.
    await expect.poll(() => mocks.userCalls.length).toBe(2);
    expect(mocks.userCalls[1].id).toBe(5001);
    await expect(page.locator(".artist-name-badge")).toHaveText(swapName);
  });

  test("gear opens settings; blocked tags filter the feed", async ({ page }) => {
    const tagged = makeFeed([
      makeIllust({ id: 9091, title: "禁断の果実", tags: [{ name: "swimsuit" }] }),
      ...makeFeedOf(29, 1).illusts,
    ]);
    const mocks = await setupApiMocks(page, { streetBatch: tagged });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Open settings from the drawer, add "swimsuit"
    await page.locator(".burger-pill").click();
    await page.locator(".drawer-item", { hasText: "Settings" }).click();
    await expect(page.locator(".modal-dialog")).toBeVisible();
    await page.locator(".blocked-tag-form input").fill("swimsuit");
    await page.locator(".blocked-tag-form button[type=submit]").click();
    await expect(page.locator(".blocked-tag-pill")).toHaveText("#swimsuit");
    await page.locator(".modal-dialog").getByRole("button", { name: "Done" }).click();

    // Switch away and back — the fresh street load drops the tagged work
    await page.locator(".burger-pill").click();
    await page.locator(".drawer-item", { hasText: "Ranking" }).click();
    await expectMainFeedCount(page, 30);
    await page.locator(".burger-pill").click();
    await page.locator(".drawer-item", { hasText: "Home" }).click();

    await expectMainFeedCount(page, 29);
    await expect(page.locator(".feed-card", { hasText: "禁断の果実" })).toHaveCount(0);
  });

  test("tag popup blocks a tag; the settings modal shows the new block", async ({ page }) => {
    const tagged = makeFeed([
      makeIllust({
        id: 9091,
        title: "Tagged work",
        tags: [
          { name: "swimsuit", translated_name: "水着" },
          { name: "cute" },
        ],
      }),
      ...makeFeedOf(29, 1).illusts,
    ]);
    await setupApiMocks(page, { streetBatch: tagged });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Open the tag popup from the card's tag button (under the heart).
    const firstCard = page.locator(".feed-card").first();
    await firstCard.locator(".tags-btn").click();
    await expect(page.locator(".tag-chip")).toHaveCount(2);
    await expect(page.locator(".tag-chip", { hasText: "swimsuit" })).toBeVisible();

    // Translated tags render a small second line under the original.
    const swimsuitChip = page.locator(".tag-chip", { hasText: "swimsuit" });
    await expect(swimsuitChip.locator(".tag-chip-name")).toHaveText("#swimsuit");
    await expect(swimsuitChip.locator(".tag-chip-translation")).toHaveText("水着");
    await expect(swimsuitChip.locator(".tag-chip-translation")).toHaveCSS("font-size", "8px");
    // No translation line for tags without one — and the chip must NOT
    // stretch to the translated neighbour's height (flex align-items:
    // stretch would leave a phantom empty second line).
    await expect(
      page.locator(".tag-chip", { hasText: "cute" }).locator(".tag-chip-translation")
    ).toHaveCount(0);
    const cuteBox = await page.locator(".tag-chip", { hasText: "cute" }).boundingBox();
    const swimsuitBox = await swimsuitChip.boundingBox();
    expect(cuteBox).not.toBeNull();
    expect(swimsuitBox).not.toBeNull();
    expect(cuteBox.height).toBeLessThan(swimsuitBox.height);

    // Block one tag — toast confirms, popup stays open.
    await swimsuitChip.click();
    await expect(page.locator(".toast")).toContainText("Blocked #swimsuit");
    await expect(
      page.locator(".tag-chip", { hasText: "swimsuit" })
    ).toHaveClass(/blocked/);

    // Close, then check Settings: the new block is in the shared list.
    await page.locator(".modal-dialog").getByRole("button", { name: "Done" }).click();
    await expect(page.locator(".tag-chip")).toHaveCount(0);
    await page.locator(".burger-pill").click();
    await page.locator(".drawer-item", { hasText: "Settings" }).click();
    await expect(page.locator(".blocked-tag-pill")).toHaveText("#swimsuit");
  });

  test("ugoira cards wait for a tap, then play/pause on the canvas", async ({ page }) => {
    const batch = makeFeed([
      makeIllust({ id: 7701, type: "ugoira", title: "うごイラ" }),
      ...makeFeedOf(5, 1).illusts,
    ]);
    const mocks = await setupApiMocks(page, { streetBatch: batch });
    await gotoApp(page);
    await expectMainFeedCount(page, 6);

    const player = page.locator(".ugoira-wrap").first();
    const control = player.locator(".ugoira-play");

    // Idle: the ▶ control over the poster CANVAS (no <img> — the canvas
    // is the only surface, so playing has no poster swap), and NO
    // meta/zip fetch yet (no autoplay).
    await expect(control).toBeVisible();
    await expect(player.locator(".ugoira-canvas")).toBeVisible();
    await expect(player.locator("img.card-image")).toHaveCount(0);
    expect(mocks.ugoiraCalls.length).toBe(0);

    // Tap the control → loads meta + zip → the loop starts on the same
    // canvas; the control flips to pause bars.
    await control.click();
    await expect.poll(() => mocks.ugoiraCalls.length).toBe(1);
    expect(mocks.ugoiraCalls[0].id).toBe(7701);
    await expect(page.locator(".ugoira-canvas")).toBeVisible({ timeout: 15_000 });
    await expect(control).toHaveAttribute("aria-label", "Pause animation");
    await expect(player.locator(".ugoira-badge")).toHaveCount(0);

    // Control taps must NOT push a related stack.
    await expect(page.locator(".related-view")).toHaveCount(0);

    // Tap the control again → paused: ▶ returns over the frozen frame.
    await control.click();
    await expect(control).toHaveAttribute("aria-label", "Play animation");
    await expect(page.locator(".ugoira-canvas")).toBeVisible();

    // Tap a third time → resumes.
    await control.click();
    await expect(control).toHaveAttribute("aria-label", "Pause animation");

    // Tapping the IMAGE (away from the centered control, below the card
    // header) opens the related-work stack like any other card.
    await player.click({ position: { x: 12, y: 300 } });
    await expect(page.locator(".related-view")).toBeVisible();
  });

  test("failed images offer a Try again button that reloads the page image", async ({ page }) => {
    const batch = makeFeed([
      makeIllust({ id: 9001, title: "Retry me" }),
      ...makeFeedOf(9, 1).illusts,
    ]);
    // The first /api/img request for this illust's large URL 500s; the
    // retry (with &r=1) succeeds.
    await setupApiMocks(page, { streetBatch: batch, imgFailOnce: "9001_p0.jpg" });
    await gotoApp(page);
    await expectMainFeedCount(page, 10);

    const firstCard = page.locator(".feed-card").first();
    const retry = firstCard.locator(".page-retry");
    await expect(retry).toBeVisible({ timeout: 15_000 });

    await retry.click();

    await expect
      .poll(() => firstCard.locator(".card-image").first().getAttribute("class"))
      .toContain("loaded");
    await expect(firstCard.locator(".page-retry")).toHaveCount(0);
  });
});
