import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";

// The queue must call the EXISTING api/illust unlike/like functions (the
// same ones FeedCard uses), so mock exactly that module.
vi.mock("../api/illust", () => ({
  like: vi.fn(),
  unlike: vi.fn(),
}));

import { like, unlike } from "../api/illust";
import { useBookmarkMover, type MoveResult } from "./useBookmarkMover";

const unlikeMock = vi.mocked(unlike);
const likeMock = vi.mocked(like);

const PACE = 50;

function setup(options: { paceMs?: number; onDone?: (r: MoveResult) => void } = {}) {
  let api!: ReturnType<typeof useBookmarkMover>;
  const dispose = createRoot((d) => {
    api = useBookmarkMover({ paceMs: PACE, ...options });
    return d;
  });
  return { api, dispose };
}

/** Flush pending microtasks (the queue's awaits settle on them). */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("useBookmarkMover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    unlikeMock.mockReset();
    likeMock.mockReset();
    unlikeMock.mockResolvedValue({ ok: true });
    likeMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs unlike → like back-to-back per work, paced between works, strictly serial", async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const impl = (name: string) => async (id: number) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`${name}:${id}`);
      await Promise.resolve();
      inFlight--;
      return { ok: true };
    };
    unlikeMock.mockImplementation(impl("unlike"));
    likeMock.mockImplementation(impl("like"));

    const done = vi.fn();
    const { api } = setup({ onDone: done });
    const running = api.run([11, 22]);

    // First upstream call happens synchronously; the like follows as
    // soon as the unlike resolves (no wait inside the pair).
    expect(events).toEqual(["unlike:11"]);
    await flush();
    expect(events).toEqual(["unlike:11", "like:11"]);

    // The throttle gap lands between works, not inside the pair.
    await vi.advanceTimersByTimeAsync(PACE);
    await flush();
    expect(events).toEqual(["unlike:11", "like:11", "unlike:22", "like:22"]);
    await running;

    expect(maxInFlight).toBe(1); // never overlapping
    expect(done).toHaveBeenCalledWith({
      moved: 2,
      failures: [],
      cancelled: false,
    });
  });

  it("stops on the first delete failure and reports the rest as cancelled", async () => {
    unlikeMock.mockImplementation(async (id: number) => {
      if (id === 1) throw new Error("500");
      return { ok: true };
    });
    const done = vi.fn();
    const { api } = setup({ onDone: done });

    await api.run([1, 2, 3]);
    await flush();

    expect(likeMock).not.toHaveBeenCalled();
    expect(unlikeMock).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith({
      moved: 0,
      failures: [
        { id: 1, kind: "delete" },
        { id: 2, kind: "cancelled" },
        { id: 3, kind: "cancelled" },
      ],
      cancelled: true,
    });
  });

  it("classifies delete-ok / add-fail as the loss window and stops", async () => {
    likeMock.mockImplementation(async (id: number) => {
      if (id === 1) throw new Error("502");
      return { ok: true };
    });
    const done = vi.fn();
    const { api } = setup({ onDone: done });

    const running = api.run([1, 2]);
    await flush(); // unlike 1 resolves, like 1 fires and rejects
    await running;

    expect(unlikeMock).toHaveBeenCalledTimes(1); // work 2 never started
    expect(done).toHaveBeenCalledWith({
      moved: 0,
      failures: [
        { id: 1, kind: "add" }, // delete succeeded → LOSS WINDOW
        { id: 2, kind: "cancelled" },
      ],
      cancelled: true,
    });
  });

  it("cancels at the next work boundary, letting the in-flight work finish", async () => {
    const done = vi.fn();
    const { api } = setup({ onDone: done });

    const running = api.run([1, 2, 3]);
    await flush(); // unlike 1 resolves
    await flush(); // like 1 fires and resolves; the between-works wait starts

    api.cancel();
    await vi.advanceTimersByTimeAsync(PACE);
    await running;

    // Work 1 fully completed (delete + re-add) despite the cancel.
    expect(unlikeMock.mock.calls.map((c) => c[0])).toEqual([1]);
    expect(likeMock.mock.calls.map((c) => c[0])).toEqual([1]);
    expect(done).toHaveBeenCalledWith({
      moved: 1,
      failures: [
        { id: 2, kind: "cancelled" },
        { id: 3, kind: "cancelled" },
      ],
      cancelled: true,
    });
  });

  it("tracks progress as completed works over the requested total", async () => {
    const { api } = setup();
    const running = api.run([1, 2]);

    expect(api.progress()).toEqual({ done: 0, total: 2 });
    await flush(); // unlike 1
    await flush(); // like 1
    expect(api.progress()).toEqual({ done: 1, total: 2 });

    await vi.advanceTimersByTimeAsync(PACE); // between works
    await flush();
    await flush();
    await running;
    expect(api.progress()).toEqual({ done: 2, total: 2 });
  });

  it("select-all selects the loaded ids; deselect-all and toggle update the count", () => {
    const { api } = setup();
    api.enterSelection();
    expect(api.selectionMode()).toBe(true);

    api.selectAll([5, 6, 7]);
    expect(api.selectedCount()).toBe(3);

    api.toggle(6);
    expect(api.selectedIds().has(6)).toBe(false);
    expect(api.selectedCount()).toBe(2);
    api.toggle(6);
    expect(api.selectedIds().has(6)).toBe(true);

    api.deselectAll();
    expect(api.selectedCount()).toBe(0);

    api.exitSelection();
    expect(api.selectionMode()).toBe(false);
  });

  it("reset clears selection when idle and aborts at the boundary when running", async () => {
    const { api } = setup();
    api.enterSelection();
    api.selectAll([1, 2]);
    api.reset();
    expect(api.selectionMode()).toBe(false);
    expect(api.selectedCount()).toBe(0);

    const running = api.run([1, 2]);
    await flush();
    api.reset(); // abort
    // The in-flight work still completes (delete → paced re-add).
    await vi.advanceTimersByTimeAsync(PACE * 3);
    await running;
    expect(api.running()).toBe(false);
  });
});
