// Tag tap → tag page e2e. Cards render tag chips row-major: row 1 fills
// (stopping before the gear), then row 2. When tags need MORE than two
// rows the strip switches to two interleaved single lines (rows
// 1,3,5→top; 2,4,6→bottom) that scroll horizontally (fade-edges like the
// search-page pills). Chips carry the Pixiv translation under the name
// when one exists. Tapping a chip opens the tag's works page (the search
// layer seeded with that tag); the gear button keeps the block popup.
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

test("tag chips fill rows then scroll; open the tag page; the gear blocks", async ({
  page,
}) => {
  const firstWork = makeIllust({
    id: "1",
    tags: TAGS,
  });
  const secondWork = makeIllust({
    id: "2",
    tags: [{ name: "few-a" }, { name: "few-b" }, { name: "few-c" }],
  });
  const rest = makeFeedOf(28, 3).illusts;
  // Home boots to the STREET feed — tag both it and top so the first
  // card is the tagged work regardless of the restored feed type.
  const batch = { illusts: [firstWork, secondWork, ...rest], next_url: null };
  const mocks = await setupApiMocks(page, {
    streetBatch: batch,
    topBatch: batch,
  });
  await gotoApp(page);

  const firstCard = page.locator(".feed-card").first();

  // 12 tags need more than two natural rows → the strip switches to two
  // interleaved lines that scroll horizontally.
  const scroller = firstCard.locator(".card-tag-scroller");
  await expect(scroller).toBeVisible();
  await expect(scroller.locator(".card-tag-chip")).toHaveCount(12);
  const metrics = await scroller.evaluate((el) => ({
    overflow: el.scrollWidth > el.clientWidth,
    height: el.clientHeight,
  }));
  expect(metrics.overflow).toBe(true);
  // Two rows of ~29px chips + 4px gap ≈ 62px.
  expect(metrics.height).toBeLessThanOrEqual(70);

  // The translation renders under the original name on chips that have one.
  const translated = scroller.locator(".card-tag-chip", { hasText: "tag-two" });
  await expect(translated.locator(".card-tag-translation")).toHaveText("Two");

  // Row-major reading order: the top line starts with the first tag.
  await expect(
    scroller.locator(".card-tag-line").first().locator(".card-tag-chip").first()
  ).toContainText("tag-one");

  // Tap the first chip → tag page opens seeded with that tag.
  await scroller.locator(".card-tag-chip").first().click();
  await expect(page.locator(".search-screen")).toBeVisible();
  await expect(page.locator(".search-input")).toHaveValue("tag-one");
  await expect
    .poll(() => mocks.searchCalls.at(-1)?.word)
    .toBe("tag-one");

  // Back out of the tag page.
  await page.locator(".related-back").click();
  await expect(page.locator(".search-screen")).toHaveCount(0);

  // Cards with few tags keep the natural wrap (no scroller).
  const secondCard = page.locator(".feed-card").nth(1);
  await expect(secondCard.locator(".card-tag-row")).toBeVisible();
  await expect(secondCard.locator(".card-tag-scroller")).toHaveCount(0);

  // The gear still opens the BLOCK popup (tap to block, not open).
  await firstCard.locator(".tags-btn").click();
  await expect(page.locator(".modal-dialog")).toBeVisible();
  await expect(page.locator(".modal-dialog")).toContainText("Tap a tag to block it");
});
