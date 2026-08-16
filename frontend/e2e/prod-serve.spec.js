// ── Prod serving e2e: the Go binary IS the server ──────────────────────
//
// Unlike the other specs (Vite dev server + every /api mocked), this one
// boots the real compiled binary (backend/pixtok-server) with the
// embedded frontend, hits it directly, and lets the GATE endpoints go to
// the real backend. The feed/image endpoints stay mocked (registered
// FIRST so the gate passthrough registered AFTER wins by LIFO).
//
// Covered: lock screen from the single binary, real unlock over HTTP,
// cookie surviving a reload, SPA fallback on deep paths, CSP header on
// the document, immutable cache on hashed assets, no-cache on index,
// and gate-locked API without a cookie.

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupApiMocks } from "./fixtures/api-mocks.js";

const PORT = 8091;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_PASSWORD = ["e2e", "test", "password"].join("-");
let server;
let cwd;

test.describe("prod serve (Go single binary)", () => {
  test.beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "pixtok-e2e-"));
    const env = {
      ...process.env,
      PIXTOK_LISTEN: `127.0.0.1:${PORT}`,
      PIXTOK_SERVE_FRONTEND: "true",
      PIXTOK_GATE_PASSWORD_HASH: TEST_PASSWORD,
      PIXTOK_GATE_ALLOW_PLAINTEXT_DEV_ONLY: "true",
      PIXTOK_PUBLIC_HTTPS: "false",
    };
    delete env.PIXTOK_API_KEY;
    server = spawn(
      join(process.cwd(), "..", "backend", "pixtok-server"),
      [],
      { cwd, env, stdio: "ignore" }
    );

    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) return;
      } catch {
        // not up yet
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error("prod server did not become healthy on :" + PORT);
  });

  test.afterAll(() => {
    server?.kill("SIGTERM");
  });

  test("unlock + reload + SPA fallback through the real backend", async ({ page }) => {
    await setupApiMocks(page);
    // Gate endpoints are real — LIFO makes this win over the mock
    // catch-all registered by setupApiMocks above.
    await page.route(/\/api\/gate(\/|$)/, (route) => route.continue());

    const resp = await page.goto(BASE);
    const csp = resp.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");

    // Lock screen renders from the embedded build.
    await expect(page.getByLabel("Gate password")).toBeVisible();

    // Real unlock: wrong password first, then the right one. Wait for
    // the error to land — the rejection handler clears the input, and a
    // fill that races the in-flight POST gets wiped by it.
    await page.getByLabel("Gate password").fill("wrong-password");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.locator(".gate-error")).toBeVisible();

    await page.getByLabel("Gate password").fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.locator(".feed-card")).toHaveCount(30, { timeout: 15000 });

    // Reload: the cookie survives, no lock screen.
    await page.reload();
    await expect(page.locator(".feed-card")).toHaveCount(30, { timeout: 15000 });

    // Deep client-side path: SPA fallback serves the app, not a 404.
    await page.goto(`${BASE}/some/client/only/route`);
    await expect(page.locator(".feed-card")).toHaveCount(30, { timeout: 15000 });
  });

  test("index is no-cache, hashed assets are immutable, API is gate-locked", async ({ request }) => {
    const idx = await request.get(BASE);
    expect(idx.headers()["cache-control"]).toContain("no-cache");

    const html = await idx.text();
    const asset = html.match(/(\/assets\/[^"]+\.js)/);
    expect(asset, "index.html must reference a hashed asset").toBeTruthy();
    const js = await request.get(BASE + asset[1]);
    expect(js.headers()["cache-control"]).toContain("immutable");
    expect(js.headers()["content-type"]).toContain("javascript");

    // Without the gate cookie the API is closed (fresh context here).
    const feed = await request.get(`${BASE}/api/top?mode=all`);
    expect(feed.status()).toBe(403);
  });
});
