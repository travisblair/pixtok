// Tag tap → tag page e2e. Cards render one scrollable row of tag chips
// (fade-edges like the search-page pills); tapping a chip opens the
// tag's works page (the search layer seeded with that tag); the gear
// button keeps the block/unblock popup.
import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeFeedOf, makeIllust } from "./fixtures/mock-data.js";
import { gotoApp } from "./fixtures/ui-helpers.js";

const TAGS = [
  "tag-one",
  "tag-two",
  "tag-three",
  "tag-four",
  "tag-five",
  "tag-six",
  "tag-seven",
  "tag-eight",
];

test("tag chips open the tag page; the row scrolls; the gear blocks", async ({
  page,
}) => {
  const firstWork = makeIllust({
    id: "1",
    tags: TAGS.map((name) => ({ name })),
  });
  const rest = makeFeedOf(29, 2).illusts;
  // Home boots to the STREET feed — tag both it and top so the first
  // card is the tagged work regardless of the restored feed type.
  const batch = { illusts: [firstWork, ...rest], next_url: null };
  const mocks = await setupApiMocks(page, {
    streetBatch: batch,
    topBatch: batch,
  });
  await gotoApp(page);

  // All chips render in one scrollable row; at phone width the content
  // overflows the row (scrollable), fading at the edges.
  const row = page.locator(".feed-card").first().locator(".card-tag-row");
  await expect(row).toBeVisible();
  await expect(row.locator(".card-tag-chip")).toHaveCount(8);
  const overflow = await row.evaluate(
    (el) => el.scrollWidth > el.clientWidth
  );
  expect(overflow).toBe(true);

  // Tap the first chip → tag page opens seeded with that tag.
  await page
    .locator(".feed-card")
    .first()
    .locator(".card-tag-chip")
    .first()
    .click();
  await expect(page.locator(".search-screen")).toBeVisible();
  await expect(page.locator(".search-input")).toHaveValue("tag-one");
  await expect
    .poll(() => mocks.searchCalls.at(-1)?.word)
    .toBe("tag-one");

  // Back out of the tag page.
  await page.locator(".related-back").click();
  await expect(page.locator(".search-screen")).toHaveCount(0);

  // The gear still opens the BLOCK popup (tap to block, not open).
  await page.locator(".feed-card").first().locator(".tags-btn").click();
  await expect(page.locator(".modal-dialog")).toBeVisible();
  await expect(page.locator(".modal-dialog")).toContainText("Tap a tag to block it");
});
