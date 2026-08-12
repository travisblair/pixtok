import { defineConfig } from "@playwright/test";

/**
 * Pixtok E2E config (freezer-app style).
 *
 * - Chromium only: the app targets modern mobile-ish WebKit/Chromium
 *   behaviour (100dvh, scroll-snap, IntersectionObserver); one browser
 *   keeps the suite fast and deterministic.
 * - webServer boots the real vite dev server. The dev proxy would forward
 *   /api to the Go backend, but every spec installs page.route() mocks
 *   for ALL /api paths before page.goto, so no request ever leaves the
 *   browser and the real backend / Pixiv is never touched.
 * - 60s per-test timeout: vite cold-compiles SolidJS on the first page of
 *   each worker; generous timeouts absorb that.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },

  use: {
    browserName: "chromium",
    headless: true,
    // Phone viewport matching the dogfood device: iPhone 16 Pro
    // (402x874 CSS px). 100dvh cards behave like the real TikTok-style UI.
    viewport: { width: 402, height: 874 },
    trace: "retain-on-failure",
  },

  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
