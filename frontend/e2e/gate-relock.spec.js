import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import { gotoApp, expectMainFeedCount, switchFeedViaDrawer } from "./fixtures/ui-helpers.js";

test.describe("Gate re-lock (mid-session)", () => {
  test("a 403 gate-locked response mid-session re-shows the gate screen", async ({
    page,
  }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // The gate cookie can leave the client mid-session (iOS Safari
    // eviction, private-mode teardown, profile switch) while the app
    // keeps running. Every gated route then answers 403 "gate locked" —
    // the app must surface the GateScreen instead of silently degrading
    // (hidden follow buttons, dead feeds, retry that can never help).
    // Later-registered Playwright routes take precedence, so this
    // shadows the fixture's bookmarks responder only.
    await page.route(/(?<!\/api)\/api\/bookmarks(\?|$)/, (route) => {
      route.fulfill({
        status: 403,
        contentType: "text/plain",
        body: "gate locked\n",
      });
    });

    await switchFeedViaDrawer(page, "Bookmarks");

    await expect(page.locator(".gate-screen")).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(".gate-form input[placeholder='Password']")
    ).toBeVisible();
    // The app UI must not render underneath a locked gate.
    await expect(page.locator(".feed-container").first()).toHaveCount(0);
  });
});
