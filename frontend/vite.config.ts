import { defineConfig } from "vitest/config";
import type { Connect, Plugin, ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import type { ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// Short git hash at build time — shown in Settings so a device's bundle
// version is checkable at a glance. iOS Safari's aggressive caching
// served stale bundles for weeks of confusing bugs; the stamp makes
// "which build is this device running?" a one-look question.
function buildStamp(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// The backend gates /api behind X-Api-Key when PIXTOK_API_KEY is set in
// .env. The dev proxy injects the header server-side so it never appears
// in browser JS — direct requests (CSRF probes, LAN peers) get 401.
// Personal network settings (Tailscale hosts, etc.) also live in .env —
// NEVER in this file: it's committed, and a public repo must not carry
// one person's tailnet.
function loadEnvValue(key: string): string {
  try {
    // Anchor on this file, not process.cwd() — launching vite from a
    // different directory must not silently yield an empty value.
    const env = readFileSync(
      join(import.meta.dirname, "..", ".env"),
      "utf8"
    );
    const line = env
      .split("\n")
      .find((l) => l.startsWith(key + "="));
    // Split on the FIRST "=" only — values can legitimately contain "="
    // (reviewer finding: split("=")[1] truncated them).
    return line ? line.slice(line.indexOf("=") + 1).trim() : "";
  } catch {
    return "";
  }
}

function loadApiKey(): string {
  return loadEnvValue("PIXTOK_API_KEY");
}

// Comma-separated extra Host header allowances (Tailscale Funnel's
// ts.net host, the machine's direct tailnet IP, a cloudflare tunnel...).
// Kept in the gitignored .env so the repo stays machine-agnostic.
function loadAllowedHosts(): string[] {
  return loadEnvValue("VITE_ALLOWED_HOSTS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The CSP the Go backend applies to app pages (see main.go) — mirrored
// here for dev so the phone and desktop exercise the exact same policy
// the production build will get. Skipped on the proxied auth paths:
// pixiv's login SPA rides through our origin and would break.
const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; " +
  "base-uri 'none'; form-action 'self'";

function cspForAppPages(): Plugin {
  return {
    name: "pixtok-csp",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(
        (req: Connect.IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
          const p = req.url || "";
          if (!p.startsWith("/api/auth/px/") && !p.startsWith("/ajax/")) {
            res.setHeader("Content-Security-Policy", APP_CSP);
          }
          next();
        }
      );
    },
  };
}

export default defineConfig({
  plugins: [solid(), cspForAppPages()],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp()),
  },
  build: {
    // The Go backend embeds the built frontend (backend/static) so the
    // production server is a single binary. Must live inside the Go
    // module (module root is backend/) for go:embed to reach it.
    outDir: "../backend/static",
    emptyOutDir: true,
  },
  server: {
    // Bind all interfaces: Tailscale Funnel dials 127.0.0.1, direct
    // tailnet access (phone) arrives on the 100.x interface. allowedHosts
    // below still rejects foreign Host headers.
    host: "0.0.0.0",
    allowedHosts: ["localhost", ...loadAllowedHosts()],
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        headers: { "X-Api-Key": loadApiKey() },
      },
      // pixiv's login SPA posts to root-relative /ajax/* paths (e.g.
      // POST /ajax/login) — those resolve against OUR origin during the
      // proxied login flow, so Vite must forward them to the backend,
      // which proxies them onward to accounts.pixiv.net.
      "/ajax": {
        target: "http://localhost:8080",
        changeOrigin: true,
        headers: { "X-Api-Key": loadApiKey() },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    exclude: ["e2e/**", "node_modules/**"],
    // REQUIRED for SolidJS component tests — see frontend-testing.md:
    // without inlining, vitest resolves solid-js/web to the SSR entry and
    // every component test fails with "Client-only API called on server".
    server: {
      deps: {
        inline: ["solid-js", "@solidjs/testing-library"],
      },
    },
  },
});
