import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getNewest, getNewestNext } from "./feeds";

// The newest-feed continuation once fetched /api/api/newest (request()
// prepends the /api base over next_url's own /api prefix) — a 404 on
// every page 2+ that retry could never fix. These pin the wire contract:
// exactly ONE /api prefix on every fetch, production route shapes only.
describe("api URL shapes (no double /api prefix)", () => {
  const calls: string[] = [];
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ illusts: [], next_url: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("newest first page fetches /api/newest exactly once", async () => {
    await getNewest(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^\/api\/newest\?/);
    expect(calls[0]).not.toContain("/api/api");
  });

  it("newest continuation strips next_url's /api prefix", async () => {
    await getNewestNext("/api/newest?r18=false&lastId=5000");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("/api/newest?r18=false&lastId=5000");
  });
});
