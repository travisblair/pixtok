import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiError, reportApiError, setOnGateLocked, setOnRequestError } from "./client";
import { getNewest } from "./feeds";

// request() is PURE transport: it classifies every failure into a typed
// ApiError and fires NOTHING — no toasts, no gate-lock listener. The
// UX policy lives in reportApiError, pinned below.
describe("request error classification (pure transport)", () => {
  const origFetch = globalThis.fetch;
  let status = 200;
  let body = "{}";
  let rejectWith: unknown = null;

  beforeEach(() => {
    status = 200;
    body = "{}";
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
    setOnGateLocked(null);
    setOnRequestError(null);
  });

  it("classifies a 403 gate-locked body as gate-locked", async () => {
    status = 403;
    body = "gate locked\n";
    await expect(getNewest(false)).rejects.toMatchObject({ kind: "gate-locked", status: 403 });
  });

  it("classifies other 403s as plain http", async () => {
    status = 403;
    body = "origin mismatch";
    await expect(getNewest(false)).rejects.toMatchObject({ kind: "http", status: 403 });
  });

  it("classifies 5xx as http", async () => {
    status = 502;
    body = "upstream error";
    await expect(getNewest(false)).rejects.toMatchObject({ kind: "http", status: 502 });
  });

  it("classifies fetch rejections as network", async () => {
    rejectWith = new TypeError("Failed to fetch");
    await expect(getNewest(false)).rejects.toMatchObject({ kind: "network" });
  });

  it("classifies TimeoutError as timeout", async () => {
    const te = new Error("boom");
    te.name = "TimeoutError";
    rejectWith = te;
    await expect(getNewest(false)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("classifies AbortError as abort", async () => {
    const ae = new Error("aborted");
    ae.name = "AbortError";
    rejectWith = ae;
    await expect(getNewest(false)).rejects.toMatchObject({ kind: "abort" });
  });

  it("classifies a non-JSON success body as bad-response", async () => {
    status = 200;
    body = "<html>not json</html>";
    await expect(getNewest(false)).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("fires NO side effects by itself", async () => {
    const gate = vi.fn();
    const toast = vi.fn();
    setOnGateLocked(gate);
    setOnRequestError(toast);
    status = 403;
    body = "gate locked\n";
    await expect(getNewest(false)).rejects.toThrow();
    expect(gate).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});

// reportApiError is the ONE place app-level reactions live: the red
// error toast and the mid-session gate re-lock. Call sites with a
// catch call it; the gate re-lock stays wired here, never scattered.
describe("reportApiError policy", () => {
  afterEach(() => {
    setOnGateLocked(null);
    setOnRequestError(null);
  });

  const err = (kind: "http" | "gate-locked" | "network" | "timeout" | "abort" | "bad-response", status = 0) =>
    new ApiError(kind, status, "x");

  it("fires 'Request failed (N)' for http", () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    expect(reportApiError(err("http", 502))).toBe("http");
    expect(fn).toHaveBeenCalledWith("Request failed (502)");
  });

  it("fires 'Network error' for network", () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    reportApiError(err("network"));
    expect(fn).toHaveBeenCalledWith("Network error");
  });

  it("fires 'Request timed out' for timeout", () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    reportApiError(err("timeout"));
    expect(fn).toHaveBeenCalledWith("Request timed out");
  });

  it("fires 'Bad response' for bad-response", () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    reportApiError(err("bad-response"));
    expect(fn).toHaveBeenCalledWith("Bad response");
  });

  it("stays silent on abort (superseded request, not a failure)", () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    reportApiError(err("abort"));
    expect(fn).not.toHaveBeenCalled();
  });

  it("fires the gate-lock listener and no toast on gate-locked", () => {
    const gate = vi.fn();
    const toast = vi.fn();
    setOnGateLocked(gate);
    setOnRequestError(toast);
    expect(reportApiError(err("gate-locked"))).toBe("gate-locked");
    expect(gate).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it("treats unknown errors as network", () => {
    const fn = vi.fn();
    setOnRequestError(fn);
    reportApiError(new Error("whatever"));
    expect(fn).toHaveBeenCalledWith("Network error");
  });
});
