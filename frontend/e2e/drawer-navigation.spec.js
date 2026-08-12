import { test, expect } from "@playwright/test";
import { setupApiMocks } from "./fixtures/api-mocks.js";
import {
  gotoApp,
  expectMainFeedCount,
  openDrawer,
  switchFeedViaDrawer,
} from "./fixtures/ui-helpers.js";

test.describe("Navigation drawer", () => {
  test("burger opens the drawer with all five feeds", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await page.locator(".burger-pill").click();
    await expect(page.locator(".drawer.open")).toBeVisible();
    await expect(page.locator(".drawer-backdrop")).toBeVisible();
    for (const label of ["Home", "Newest", "Illustrations", "Ranking", "Discover"]) {
      await expect(
        page.locator(".drawer-item", { hasText: label })
      ).toBeVisible();
    }
    await expect(page.locator(".drawer-item", { hasText: "Settings" })).toBeVisible();
    // Home is the active feed
    await expect(page.locator(".drawer-item.active")).toHaveText("Home");
  });

  test("✕ closes the drawer", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await openDrawer(page);
    await expect(page.locator(".drawer.open")).toBeVisible();

    await page.locator(".drawer-close").click();

    await expect(page.locator(".drawer.open")).toHaveCount(0);
    await expect(page.locator(".drawer-backdrop")).toHaveCount(0);
  });

  test("clicking the backdrop closes the drawer", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await openDrawer(page);
    await expect(page.locator(".drawer.open")).toBeVisible();

    // Click the backdrop OUTSIDE the 280px drawer (drawer overlays the
    // left edge of the 402px viewport, so aim right of it).
    await page
      .locator(".drawer-backdrop")
      .click({ position: { x: 350, y: 400 } });

    await expect(page.locator(".drawer.open")).toHaveCount(0);
    await expect(page.locator(".drawer-backdrop")).toHaveCount(0);
  });

  test("pills appear only on the Ranking tab", async ({ page }) => {
    const mocks = await setupApiMocks(page); // street: 30, top: 30, recs: 5
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    // Home: no pills
    await expect(page.locator(".mode-selector")).toHaveCount(0);

    // Ranking: pills + ranking feed
    await switchFeedViaDrawer(page, "Ranking");
    await expectMainFeedCount(page, 30);
    await expect(page.locator(".mode-selector")).toBeVisible();
    await expect(page.locator(".content-pills .mode-pill.active")).toHaveText("All");
    await expect.poll(() => mocks.topModes).toEqual(["day"]);

    // Discover: pills gone again
    await switchFeedViaDrawer(page, "Discover");
    await expectMainFeedCount(page, 5);
    await expect(page.locator(".mode-selector")).toHaveCount(0);

    // Back to Home: still no pills
    await switchFeedViaDrawer(page, "Home");
    await expectMainFeedCount(page, 30);
    await expect(page.locator(".mode-selector")).toHaveCount(0);
  });

  test("Account opens the login screen with live auth status", async ({ page }) => {
    await setupApiMocks(page);
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await openDrawer(page);
    await page.locator(".drawer-item", { hasText: "Account" }).click();

    // Connected banner + two green surface rows when fully authed.
    await expect(page.locator(".auth-status.ok")).toHaveCount(3);
    await expect(page.locator(".reauth-link")).toHaveAttribute(
      "href",
      "/api/auth/pkce/start"
    );

    // Close and reopen — status still probes live.
    await page.locator(".modal-x").click();
    await openDrawer(page);
    await page.locator(".drawer-item", { hasText: "Account" }).click();
    await expect(page.locator(".auth-status.ok")).toHaveCount(3);
  });

  test("Account reflects an unhealthy auth surface", async ({ page }) => {
    await setupApiMocks(page, {
      authStatus: { app_api: true, web_session: false },
    });
    await gotoApp(page);
    await expectMainFeedCount(page, 30);

    await openDrawer(page);
    await page.locator(".drawer-item", { hasText: "Account" }).click();

    // Connected banner + the healthy App API row; the web surface red.
    await expect(page.locator(".auth-status.ok")).toHaveCount(2);
    await expect(page.locator(".auth-status.bad")).toHaveCount(1);
  });
});
