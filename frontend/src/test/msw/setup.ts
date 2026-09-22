import { afterAll, afterEach, beforeAll } from "vitest";
import { resetServerState, server, unhandledApiRequests } from "./server";

/**
 * MSW lifecycle for the shared /api fixture (registered as a vitest
 * setupFile in vite.config.ts).
 *
 * onUnhandledRequest: anything under /api that no handler matched is a
 * HARD error (print.error() rejects the caller's fetch loudly). The one
 * documented bypass: non-/api URLs — assets, blob:/data: URLs, jsdom
 * internals — are not part of the API contract this fixture pins, so
 * they pass through untouched.
 */
beforeAll(() =>
  server.listen({
    onUnhandledRequest(request, print) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        print.error();
      }
      // else: bypass — not an /api request, outside this fixture's scope.
    },
  })
);

afterEach(() => {
  // Belt and braces for the fallback handler: an /api request that
  // reached it produced a 500 the UI may have swallowed, so fail the
  // test here with the path list instead of letting it pass silently.
  if (unhandledApiRequests.length > 0) {
    const list = [...new Set(unhandledApiRequests)].join(", ");
    resetServerState();
    throw new Error(
      `Unhandled /api request(s) answered by the MSW fallback: ${list}. ` +
        `Add a handler in src/test/msw/handlers.ts (or a server.use() override) — ` +
        `a lenient fallback would mask a broken request path.`
    );
  }
  resetServerState();
});

afterAll(() => server.close());
