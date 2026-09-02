import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ logEvent: vi.fn() }));

import { logEvent } from "./api";
import { installCrashTrap, uploadCrashBuffer } from "./crash-trap";

const KEY = "pixtok_crash_ring";

function fireError(msg: string, err?: Error) {
  window.dispatchEvent(
    new ErrorEvent("error", {
      message: msg,
      filename: "https://host/assets/index-abc.js",
      lineno: 12,
      colno: 4,
      error: err ?? new Error(msg),
    }),
  );
}

function fireRejection(reason: unknown) {
  window.dispatchEvent(
    new PromiseRejectionEvent("unhandledrejection", {
      promise: Promise.resolve(),
      reason,
    }),
  );
}

interface Entry {
  t: number;
  kind: string;
  m: string;
  s?: string;
  u?: string;
  l?: number;
  c?: number;
}

function ring(): Entry[] {
  const raw = sessionStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Entry[]) : [];
}

describe("crash trap", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    installCrashTrap(); // idempotent; listeners are global
  });

  it("records an uncaught error with message, stack, and location", () => {
    const boom = new Error("boom");
    fireError("Uncaught boom", boom);
    const entries = ring();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "error",
      m: "Uncaught boom",
      u: "https://host/assets/index-abc.js",
      l: 12,
      c: 4,
    });
    expect(entries[0].s).toContain("boom");
  });

  it("records an unhandled rejection with an Error reason", () => {
    const err = new Error("nope");
    fireRejection(err);
    const entries = ring();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "rejection", m: "nope" });
    expect(entries[0].s).toContain("nope");
  });

  it("records a non-Error rejection reason as a string", () => {
    fireRejection("dead promise");
    const entries = ring();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "rejection", m: "dead promise" });
  });

  it("skips AbortError — aborted fetches are normal life", () => {
    fireError("The operation was aborted.", Object.assign(new Error("aborted"), { name: "AbortError" }));
    fireRejection(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect(ring()).toHaveLength(0);
  });

  it("caps the ring at 6, evicting the oldest", () => {
    for (let i = 0; i < 8; i++) {
      fireError(`error ${i}`);
    }
    const entries = ring();
    expect(entries).toHaveLength(6);
    expect(entries[0].m).toBe("error 2");
    expect(entries[5].m).toBe("error 7");
  });

  it("de-dupes identical consecutive entries", () => {
    fireError("same error");
    fireError("same error");
    fireError("same error");
    expect(ring()).toHaveLength(1);
  });

  it("uploads ring contents as crash events and clears the ring", () => {
    fireError("first");
    fireRejection(new Error("second"));
    uploadCrashBuffer();
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(logEvent).toHaveBeenCalledWith("crash", "error", expect.objectContaining({ m: "first" }));
    expect(logEvent).toHaveBeenCalledWith("crash", "rejection", expect.objectContaining({ m: "second" }));
    expect(ring()).toHaveLength(0);
  });

  it("does nothing when the ring is empty", () => {
    uploadCrashBuffer();
    expect(logEvent).not.toHaveBeenCalled();
  });
});
