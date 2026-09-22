import { setupServer } from "msw/node";
import {
  fallbackHandler,
  handlers,
  resetPrefsState,
  unhandledApiRequests,
} from "./handlers";

export { handlers, unhandledApiRequests };

/**
 * The shared MSW server: default handlers + a loud fallback for /api
 * paths nobody handled. Lifecycle lives in ./setup.ts (registered as a
 * vitest setupFile) so every component test runs real fetch() through
 * it — components call the REAL api/*.ts functions, request() does its
 * ApiError classification for real, and MSW answers at the HTTP
 * boundary. Per-test variations use server.use(...).
 */
export const server = setupServer(...handlers, fallbackHandler);

/**
 * Request journal — every request MSW sees, in arrival order. Counts are
 * recorded SYNCHRONOUSLY inside the fetch() call (MSW emits
 * "request:start" before yielding), so call-count assertions like
 * "double-tap must not fire a second POST" keep working.
 *
 * Bodies are read lazily from a clone: await entry.json() / bodyText().
 */
export type JournalEntry = {
  method: string;
  url: string;
  path: string;
  params: URLSearchParams;
  bodyText: () => Promise<string>;
  json: () => Promise<unknown>;
};

export const requests: JournalEntry[] = [];

server.events.on("request:start", ({ request }) => {
  const url = new URL(request.url);
  // Clone so the body can be read later without disturbing the handler
  // that owns the original request.
  const clone = request.clone();
  let textPromise: Promise<string> | undefined;
  const readText = () => (textPromise ??= clone.text());
  requests.push({
    method: request.method,
    url: request.url,
    path: url.pathname,
    params: url.searchParams,
    bodyText: readText,
    json: async () => JSON.parse(await readText()),
  });
});

/** Journal entries for one exact pathname. */
export function requestsTo(path: string): JournalEntry[] {
  return requests.filter((r) => r.path === path);
}

/** How many requests hit one exact pathname. */
export function requestCount(path: string): number {
  return requestsTo(path).length;
}

/** Query-param view of each request to one path — the network-level
 * equivalent of "api function called with {...}". */
export function requestParams(path: string): Record<string, string>[] {
  return requestsTo(path).map((r) => Object.fromEntries(r.params.entries()));
}

export function clearRequests() {
  requests.length = 0;
}

/** Per-test reset: runtime handlers, journal, prefs state, fallback log. */
export function resetServerState() {
  server.resetHandlers();
  clearRequests();
  resetPrefsState();
  unhandledApiRequests.length = 0;
}
