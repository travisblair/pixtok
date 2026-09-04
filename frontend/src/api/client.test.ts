import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, setOnGateLocked, setOnRequestError } from "./index";

// Mid-session gate re-lock: a 403 "gate locked" on ANY later request
// must fire the registered listener (App re-shows the GateScreen).
// Other 403s (e.g. an origin mismatch) must not.
describe("mid-session gate re-lock detection", () => {
  const origFetch = globalThis.fetch;
  let status = 200;
  let body = "{}";

  afterEach(() => {
    globalThis.fetch = origFetch;
    setOnGateLocked(null);
  });

  it("fires the listener on a 403 gate-locked response", async () => {
    const fn = vi.fn();
    setOnGateLocked(fn);
    status = 403;
    body = "gate locked\n";
    globalThis.fetch = vi.fn(async () => {
      return new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await expect(api.getNewest(false)).rejects.toThrow("403");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ignores 403s that are not gate locks", async () => {
    const fn = vi.fn();
    setOnGateLocked(fn);
    status = 403;
    body = "origin mismatch";
    globalThis.fetch = vi.fn(async () => {
      return new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await expect(api.getNewest(false)).rejects.toThrow("403");
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not fire on successful responses", async () => {
    const fn = vi.fn();
    setOnGateLocked(fn);
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ illusts: [], next_url: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
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
    body = "{}";
    rejectWith = null;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    setOnRequestError(null);
  });

  function mockFetch() {
    globalThis.fetch = vi.fn(async () => {
      if (rejectWith) throw rejectWith;
      return new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  it("fires 'Request failed (N)' on HTTP errors", async () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    status = 502;
    body = "upstream error";
    mockFetch();
    await expect(api.getNewest(false)).rejects.toThrow("502");
    expect(fn).toHaveBeenCalledWith("Request failed (502)");
  });

  it("fires 'Network error' on fetch rejection", async () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    rejectWith = new TypeError("Failed to fetch");
    mockFetch();
    await expect(api.getNewest(false)).rejects.toThrow();
    expect(fn).toHaveBeenCalledWith("Network error");
  });

  it("fires 'Request timed out' on TimeoutError", async () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    const te = new Error("boom");
    te.name = "TimeoutError";
    rejectWith = te;
    mockFetch();
    await expect(api.getNewest(false)).rejects.toThrow();
    expect(fn).toHaveBeenCalledWith("Request timed out");
  });

  it("stays silent on AbortError (superseded request, not a failure)", async () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    const ae = new Error("aborted");
    ae.name = "AbortError";
    rejectWith = ae;
    mockFetch();
    await expect(api.getNewest(false)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("stays silent on a gate-locked 403 (the GateScreen owns that UX)", async () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    status = 403;
    body = "gate locked\n";
    mockFetch();
    await expect(api.getNewest(false)).rejects.toThrow("403");
    expect(fn).not.toHaveBeenCalled();
  });
});
