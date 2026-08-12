// ── Shared UI helpers (freezer-app style) ───────────────────────────────
import { expect } from "@playwright/test";

/** Navigate to the app root. Mocks must be installed BEFORE calling this. */
export async function gotoApp(page) {
  await page.goto("http://localhost:5173/");
}

/**
 * Assert the MAIN feed container's card count (the first .feed-container
 * in the document is the root feed — modal/related feeds come later).
 */
export async function expectMainFeedCount(page, count, timeout = 20_000) {
  await expect(
    page.locator(".feed-container").first().locator(".feed-card")
  ).toHaveCount(count, { timeout });
}

/** Click the ☰ burger pill to open the navigation drawer. */
export async function openDrawer(page) {
  await page.locator(".burger-pill").click();
}

/** Open the drawer and click a nav item (e.g. "Home", "Discover"). */
export async function switchFeedViaDrawer(page, label) {
  await openDrawer(page);
  await expect(page.locator(".drawer.open")).toBeVisible();
  await page.locator(".drawer-item", { hasText: label }).click();
  await expect(page.locator(".drawer.open")).toHaveCount(0);
}

/** Read the main feed container's scrollTop. */
export async function feedScrollTop(page) {
  return page.evaluate(
    () => document.querySelector(".feed-container")?.scrollTop ?? 0
  );
}

/**
 * Scroll the given scroll container by n viewport heights, landing on an
 * exact snap point (cards are 100dvh, so multiples of the viewport height
 * are always valid snap positions — no snap-settle drift).
 */
export async function scrollFeedByViewports(page, n, container = ".feed-container") {
  const vh = (await page.viewportSize()).height;
  await page.evaluate(
    ({ sel, vh, n }) => {
      const el = document.querySelector(sel);
      el.scrollTop = el.scrollTop + vh * n;
    },
    { sel: container, vh, n }
  );
}

/** Scroll the given container to its absolute bottom. */
export async function scrollFeedToBottom(page, container = ".feed-container") {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el.scrollTop = el.scrollHeight - el.clientHeight;
  }, container);
}

/** Small settle delay for scroll-snap / IO hysteresis to play out. */
export async function settle(ms = 400) {
  await new Promise((r) => setTimeout(r, ms));
}
