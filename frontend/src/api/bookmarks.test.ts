import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api } from "./index";

// The backend 400s /api/bookmarks without an offset. The first load
// once omitted it — every page-open 400'd into the empty state, and the
// e2e mock's `?? 0` default masked it. Pin offset=0 on the wire.
describe("bookmarks page wire contract (offset required)", () => {
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

  it("first page carries offset=0", async () => {
    await api.getBookmarks();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("/api/bookmarks?tag=&offset=0");
  });

  it("tag-filtered first page carries offset=0", async () => {
    await api.getBookmarks("tag-one");
    expect(calls[0]).toBe("/api/bookmarks?tag=tag-one&offset=0");
  });

  it("continuation rides the backend's own offset URL, exactly one /api prefix", async () => {
    await api.getBookmarksNext("/api/bookmarks?tag=tag-one&offset=48");
    expect(calls[0]).toBe("/api/bookmarks?tag=tag-one&offset=48");
    expect(calls[0]).not.toContain("/api/api");
  });
});
