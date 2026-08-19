import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { api, setOnGateLocked, setOnRequestError } from "./api";

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
    await api.getNewest(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^\/api\/newest\?/);
    expect(calls[0]).not.toContain("/api/api");
  });

  it("newest continuation strips next_url's /api prefix", async () => {
    await api.getNewestNext("/api/newest?r18=false&lastId=5000");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("/api/newest?r18=false&lastId=5000");
  });
});

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

// Mid-session gate re-lock: a 403 "gate locked" on ANY later request
// must fire the registered listener (App re-shows the GateScreen).
// Other 403s (e.g. an origin mismatch) must not.
describe("mid-session gate re-lock detection", () => {
  const origFetch = globalThis.fetch;
  let status = 200;
  let body = "{}";

  beforeEach(() => {
    status = 200;
    body = JSON.stringify({ illusts: [], next_url: null });
    globalThis.fetch = vi.fn(async () => {
      return new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    setOnGateLocked(null);
  });

  it("fires the listener on a 403 gate-locked response", async () => {
    const fn = vi.fn();
    setOnGateLocked(fn);
    status = 403;
    body = "gate locked\n";
    await expect(api.getNewest(false)).rejects.toThrow("403");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ignores 403s that are not gate locks", async () => {
    const fn = vi.fn();
    setOnGateLocked(fn);
    status = 403;
    body = "origin mismatch";
    await expect(api.getNewest(false)).rejects.toThrow("403");
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not fire on successful responses", async () => {
    const fn = vi.fn();
    setOnGateLocked(fn);
    await api.getNewest(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

// Any failed request surfaces in the red top error toast — except gate
// locks (the GateScreen owns those) and superseded-request aborts.
describe("request error notifications", () => {
  const origFetch = globalThis.fetch;
  let status = 200;
  let body = "{}";
  let rejectWith: unknown = null;

  beforeEach(() => {
    status = 200;
    body = JSON.stringify({ illusts: [], next_url: null });
    rejectWith = null;
    globalThis.fetch = vi.fn(async () => {
      if (rejectWith) throw rejectWith;
      return new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    setOnRequestError(null);
  });

  it("fires 'Request failed (N)' on HTTP errors", async () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    status = 502;
    body = "upstream error";
    await expect(api.getNewest(false)).rejects.toThrow("502");
    expect(fn).toHaveBeenCalledWith("Request failed (502)");
  });

  it("fires 'Network error' on fetch rejection", async () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    rejectWith = new TypeError("Failed to fetch");
    await expect(api.getNewest(false)).rejects.toThrow();
    expect(fn).toHaveBeenCalledWith("Network error");
  });

  it("fires 'Request timed out' on TimeoutError", async () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    const te = new Error("boom");
    te.name = "TimeoutError";
    rejectWith = te;
    await expect(api.getNewest(false)).rejects.toThrow();
    expect(fn).toHaveBeenCalledWith("Request timed out");
  });

  it("stays silent on AbortError (superseded request, not a failure)", async () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    const ae = new Error("aborted");
    ae.name = "AbortError";
    rejectWith = ae;
    await expect(api.getNewest(false)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("stays silent on a gate-locked 403 (the GateScreen owns that UX)", async () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    status = 403;
    body = "gate locked\n";
    await expect(api.getNewest(false)).rejects.toThrow("403");
    expect(fn).not.toHaveBeenCalled();
  });
});
