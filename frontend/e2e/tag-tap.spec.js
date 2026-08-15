// Tag tap → tag page e2e. Cards render tag chips in TWO rows (column
// flow); more tags than fit wrap into columns to the right and the row
// scrolls horizontally (fade-edges like the search-page pills). Chips
// carry the Pixiv translation under the name when one exists. Tapping a
// chip opens the tag's works page (the search layer seeded with that
// tag); the gear button keeps the block/unblock popup.
import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { makeFeedOf, makeIllust } from "./fixtures/mock-data.js";
import { gotoApp } from "./fixtures/ui-helpers.js";

const TAGS = [
  { name: "tag-one" },
  { name: "tag-two", translated_name: "Two" },
  { name: "tag-three" },
  { name: "tag-four" },
  { name: "tag-five" },
  { name: "tag-six" },
  { name: "tag-seven" },
  { name: "tag-eight" },
  { name: "tag-nine" },
  { name: "tag-ten" },
  { name: "tag-eleven" },
  { name: "tag-twelve" },
];

test("tag chips wrap 2 rows then scroll; open the tag page; the gear blocks", async ({
  page,
}) => {
  const firstWork = makeIllust({
    id: "1",
    tags: TAGS,
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

  // All 12 chips render; the row is capped at TWO chip-rows tall and the
  // rest overflow into columns to the right (horizontal scroll).
  const row = page.locator(".feed-card").first().locator(".card-tag-row");
  await expect(row).toBeVisible();
  await expect(row.locator(".card-tag-chip")).toHaveCount(12);
  const metrics = await row.evaluate((el) => ({
    overflow: el.scrollWidth > el.clientWidth,
    height: el.clientHeight,
  }));
  expect(metrics.overflow).toBe(true);
  // Two rows of ~29px chips + 4px gap ≈ 62px.
  expect(metrics.height).toBeLessThanOrEqual(70);

  // The translation renders under the original name on chips that have one.
  const translated = row.locator(".card-tag-chip", { hasText: "tag-two" });
  await expect(translated.locator(".card-tag-translation")).toHaveText("Two");

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
