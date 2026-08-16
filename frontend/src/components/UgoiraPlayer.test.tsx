import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { zipSync } from "fflate";
import UgoiraPlayer from "./UgoiraPlayer";

/**
 * UgoiraPlayer unit tests.
 *
 * What is REAL here: fflate unzip, frame-to-delay mapping, the loadSeq
 * discard guard, zip abort, downscale math, and the timer-driven step
 * loop - all exercised end-to-end from the component's actual entry
 * points (the parent's toggle signal, IntersectionObserver teardown).
 *
 * What is mocked (jsdom cannot do these): Image decoding (frames fire
 * onload synchronously with queued natural sizes) and canvas 2d
 * contexts (drawImage is spied; canvas width/height are the real
 * downscale math the component computes).
 *
 * Interaction model (Aug 2026): the play/pause CONTROL lives in the
 * card overlay (FeedCard), driven by a counter signal handed to the
 * player; the player reports status back. Image taps fall through to
 * the card and open the related stack — the wrap has no click handler.
 */

vi.mock("../api", () => ({
  api: {
    getUgoiraMeta: vi.fn(),
  },
}));

import { api } from "../api";
const mockedApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const META = {
  error: false,
  body: {
    src: "https://img-zip-ugoira.i.pximg.net/mock/7701_ugoira600x600.zip",
    originalSrc:
      "https://img-zip-ugoira.i.pximg.net/mock/7701_ugoira1920x1080.zip",
    mime_type: "image/jpeg",
    frames: [
      { file: "000000.jpg", delay: 100 },
      { file: "000001.jpg", delay: 200 },
    ],
  },
};

// ---- Image mock: each new Image() consumes the next queued size --------
const frameSizeQueue: number[][] = [];
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_: string) {
    const size = frameSizeQueue.shift() ?? [100, 100];
    this.naturalWidth = size[0];
    this.naturalHeight = size[1];
    this.onload?.();
  }
  get src() {
    return "";
  }
}

// ---- Canvas mock: every 2d context gets its own drawImage spy ----------
const ctxByCanvas = new WeakMap<
  HTMLCanvasElement,
  { drawImage: ReturnType<typeof vi.fn> }
>();
const canvasesInCreationOrder: HTMLCanvasElement[] = [];

// ---- fetch mock ---------------------------------------------------------
interface FetchCall {
  url: string;
  signal?: AbortSignal | null;
}
const fetchCalls: FetchCall[] = [];
let zipBytes: Uint8Array = new Uint8Array();

function makeZip(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 0 });
}

function abortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

function installFetchMock(opts?: { ok?: boolean; status?: number; stall?: boolean }) {
  const mock = vi.fn(
    (url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        fetchCalls.push({ url, signal });
        const respond = () =>
          resolve({
            ok: opts?.ok ?? true,
            status: opts?.status ?? 200,
            arrayBuffer: async () => zipBytes.slice().buffer,
            blob: async () => new Blob([zipBytes.slice()]),
          } as unknown as Response);
        if (opts?.stall) {
          if (signal?.aborted) return reject(abortError());
          signal?.addEventListener("abort", () => reject(abortError()), {
            once: true,
          });
          return; // never resolves; only the abort fires
        }
        respond();
      })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * Harness that mirrors FeedCard's wiring: a toggle counter handed to the
 * player, the reported status rendered as text for assertions.
 */
function Harness() {
  const [sig, setSig] = createSignal(0);
  const [st, setSt] = createSignal<string>("idle");
  return (
    <>
      <button
        data-testid="ctl"
        type="button"
        onClick={() => setSig((x) => x + 1)}
      >
        ctl
      </button>
      <span data-testid="st">{st()}</span>
      <UgoiraPlayer
        illustId={7701}
        staticUrl="https://i.pximg.net/img-original/static.jpg"
        title="うごイラ"
        toggleSignal={sig()}
        onStatus={setSt}
      />
    </>
  );
}

function renderPlayer() {
  return render(() => <Harness />);
}

function wrapEl(container: HTMLElement) {
  return container.querySelector(".ugoira-wrap") as HTMLElement;
}
function statusText(container: HTMLElement) {
  return container.querySelector('[data-testid="st"]')!.textContent;
}
function visibleCanvas(container: HTMLElement) {
  return container.querySelector(
    "canvas.ugoira-canvas"
  ) as HTMLCanvasElement | null;
}
function visibleDraws(container: HTMLElement) {
  const c = visibleCanvas(container);
  return c ? ctxByCanvas.get(c)!.drawImage : vi.fn();
}
/** Bumps the parent's toggle signal — the only playback control. */
function tapControl(container: HTMLElement) {
  fireEvent.click(container.querySelector('[data-testid="ctl"]')!);
}
/** The IntersectionObserver the component registered on mount. */
function mountedObserver(): {
  callback: (entries: { isIntersecting: boolean }[]) => void;
} {
  const IO = globalThis.IntersectionObserver as unknown as {
    instances: {
      callback: (entries: { isIntersecting: boolean }[]) => void;
    }[];
  };
  return IO.instances[IO.instances.length - 1];
}
function scrollAway() {
  mountedObserver().callback([{ isIntersecting: false }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  frameSizeQueue.length = 0;
  canvasesInCreationOrder.length = 0;
  fetchCalls.length = 0;
  zipBytes = makeZip({
    "000000.jpg": new Uint8Array([1, 2, 3]),
    "000001.jpg": new Uint8Array([4, 5, 6]),
  });
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement, id: string) {
      if (id !== "2d") return null as never;
      let ctx = ctxByCanvas.get(this);
      if (!ctx) {
        ctx = { drawImage: vi.fn() };
        ctxByCanvas.set(this, ctx);
        canvasesInCreationOrder.push(this);
      }
      return ctx as never;
    } as never
  );
  installFetchMock(); // happy path by default
  mockedApi.getUgoiraMeta.mockReset();
  mockedApi.getUgoiraMeta.mockResolvedValue(META);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Pump microtasks WITHOUT advancing fake timers (waitFor advances them,
 * which lets the 100ms frame timer fire mid-test and makes draw counts
 * nondeterministic). All mocked async pieces resolve on microtasks.
 */
async function flushMicrotasks(n = 30) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

async function playThrough(container: HTMLElement) {
  tapControl(container);
  await flushMicrotasks();
  expect(statusText(container)).toBe("playing");
}

/** Shared helper: play through to the error badge state. */
async function playThroughExpectError(container: HTMLElement) {
  tapControl(container);
  await flushMicrotasks();
  expect(container.querySelector(".ugoira-badge")).toBeTruthy();
}

describe("UgoiraPlayer", () => {
  it("renders idle with the static frame on the canvas - no autoplay, no meta/zip", async () => {
    const { container } = renderPlayer();
    expect(statusText(container)).toBe("idle");
    // The canvas IS the poster — mounted from the start (no <img> swap).
    expect(visibleCanvas(container)).toBeTruthy();
    expect(container.querySelector("img.card-image")).toBeNull();
    expect(container.querySelector(".ugoira-spinner")).toBeNull();
    expect(container.querySelector(".ugoira-badge")).toBeNull();
    expect(mockedApi.getUgoiraMeta).not.toHaveBeenCalled();
    // Exactly ONE fetch on mount: the static poster frame.
    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0].url).toContain("/api/img?url=");
  });

  it("toggle -> spinner -> playing on the canvas; status reports back", async () => {
    const { container } = renderPlayer();
    tapControl(container);
    expect(container.querySelector(".ugoira-spinner")).toBeTruthy();
    await flushMicrotasks();
    expect(container.querySelector(".ugoira-spinner")).toBeNull();
    expect(statusText(container)).toBe("playing");
    expect(mockedApi.getUgoiraMeta).toHaveBeenCalledTimes(1);
    // First fetch = static poster (discarded once playback wins), second
    // = the frame zip.
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    expect(fetchCalls[0].url).toContain("/api/img?url=");
    expect(fetchCalls[1].url).toContain("/api/img?url=");
  });

  it("the parent's toggle signal drives play, pause, and resume", async () => {
    const { container } = renderPlayer();
    await playThrough(container);
    tapControl(container); // pause
    expect(statusText(container)).toBe("paused");
    tapControl(container); // resume
    expect(statusText(container)).toBe("playing");
  });

  it("downscales oversized frames to 800px and leaves small frames alone", async () => {
    // Creation order in a tap flow (the static poster is discarded when
    // playback supersedes it, so the visible canvas never draws the
    // static frame and isn't registered until step()): [0] static-frame
    // canvas, [1] frame 0, [2] frame 1, [3] the visible canvas.
    frameSizeQueue.push([400, 300], [1600, 1200], [400, 300]);
    const { container } = renderPlayer();
    await playThrough(container);

    // Static poster frame: 400x300 unchanged.
    expect(canvasesInCreationOrder[0].width).toBe(400);
    expect(canvasesInCreationOrder[0].height).toBe(300);
    // First frame 1600x1200 -> 800x600; second 400x300 -> unchanged.
    expect(canvasesInCreationOrder[1].width).toBe(800);
    expect(canvasesInCreationOrder[1].height).toBe(600);
    expect(canvasesInCreationOrder[2].width).toBe(400);
    expect(canvasesInCreationOrder[2].height).toBe(300);
  });

  it("never upscales small frames (100x100 stays 100x100)", async () => {
    frameSizeQueue.push([100, 100], [100, 100], [100, 100]);
    const { container } = renderPlayer();
    await playThrough(container);
    expect(canvasesInCreationOrder[1].width).toBe(100);
    expect(canvasesInCreationOrder[1].height).toBe(100);
  });

  it("honours a smaller frame budget (grid cells: 360px frames)", async () => {
    // The grid renderer passes maxFrameSide=360 / maxPosterSide=720 so a
    // cell's canvases stay ~1/5 of a strip card's frame pixels.
    frameSizeQueue.push([1600, 1200], [1600, 1200], [1600, 1200]);
    const [sig, setSig] = createSignal(0);
    const { container } = render(() => (
      <>
        <button data-testid="ctl" type="button" onClick={() => setSig((x) => x + 1)}>
          ctl
        </button>
        <span data-testid="st">status</span>
        <UgoiraPlayer
          illustId={7701}
          staticUrl="https://i.pximg.net/img-original/static.jpg"
          title="うごイラ"
          toggleSignal={sig()}
          maxFrameSide={360}
          maxPosterSide={720}
        />
      </>
    ));
    tapControl(container);
    await flushMicrotasks();

    // Poster (static frame): capped at 720 (1600x1200 -> 720x540).
    expect(canvasesInCreationOrder[0].width).toBe(720);
    expect(canvasesInCreationOrder[0].height).toBe(540);
    // Animation frames: capped at 360 (1600x1200 -> 360x270).
    expect(canvasesInCreationOrder[1].width).toBe(360);
    expect(canvasesInCreationOrder[1].height).toBe(270);
    expect(canvasesInCreationOrder[2].width).toBe(360);
    expect(canvasesInCreationOrder[2].height).toBe(270);
  });

  it("steps frames honouring each frame's delay", async () => {
    frameSizeQueue.push([100, 100], [1600, 1200], [400, 300]);
    const { container } = renderPlayer();
    await playThrough(container);

    // Reset the timer chain to a known zero point: pause clears the
    // pending timer; resume draws immediately and re-schedules.
    tapControl(container); // pause
    tapControl(container); // resume - draws frame 1 now (idx was 1)
    const draws = visibleDraws(container);
    // Creation order in a tap flow: [0] static-frame canvas, [1] frame 0,
    // [2] frame 1, [3] the visible canvas. (The static poster was
    // discarded when playback superseded it — it never draws.)
    const f0 = canvasesInCreationOrder[1];
    const f1 = canvasesInCreationOrder[2];
    expect(draws).toHaveBeenCalledTimes(2);
    expect(draws.mock.calls[0][0]).toBe(f0);
    expect(draws.mock.calls[1][0]).toBe(f1);

    // Frame 1's delay is 200ms: nothing for 199, then frame 0 again.
    vi.advanceTimersByTime(199);
    expect(draws).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(draws).toHaveBeenCalledTimes(3);
    expect(draws.mock.calls[2][0]).toBe(f0);
    // Frame 0's delay is 100ms.
    vi.advanceTimersByTime(100);
    expect(draws).toHaveBeenCalledTimes(4);
    expect(draws.mock.calls[3][0]).toBe(f1);
  });

  it("clamps tiny delays to a 20ms floor", async () => {
    mockedApi.getUgoiraMeta.mockResolvedValue({
      error: false,
      body: {
        src: "z",
        mime_type: "image/jpeg",
        frames: [
          { file: "000000.jpg", delay: 5 },
          { file: "000001.jpg", delay: 1 },
        ],
      },
    });
    const { container } = renderPlayer();
    await playThrough(container);
    tapControl(container); // pause
    tapControl(container); // resume - schedules with the clamped floor
    const draws = visibleDraws(container);
    // frame 0 + resume's frame 1
    expect(draws).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(19);
    expect(draws).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(draws).toHaveBeenCalledTimes(3);
  });

  it("a delay of 0 falls back to the 60ms default", async () => {
    mockedApi.getUgoiraMeta.mockResolvedValue({
      error: false,
      body: {
        src: "z",
        mime_type: "image/jpeg",
        frames: [{ file: "000000.jpg", delay: 0 }],
      },
    });
    const { container } = renderPlayer();
    await playThrough(container);
    tapControl(container); // pause
    tapControl(container); // resume - schedules with the 60ms default
    const draws = visibleDraws(container);
    // frame 0 + resume's draw (single-frame loop)
    expect(draws).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(59);
    expect(draws).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(draws).toHaveBeenCalledTimes(3);
  });

  it("pause freezes the canvas; no stepping while paused", async () => {
    const { container } = renderPlayer();
    await playThrough(container);
    tapControl(container); // pause
    expect(statusText(container)).toBe("paused");
    expect(visibleCanvas(container)).toBeTruthy(); // frozen frame stays
    const before = visibleDraws(container).mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(visibleDraws(container).mock.calls.length).toBe(before);
  });

  it("a second toggle during loading is ignored (no duplicate meta fetches)", async () => {
    let resolveMeta!: (v: unknown) => void;
    mockedApi.getUgoiraMeta.mockImplementationOnce(
      () => new Promise((r) => (resolveMeta = r))
    );
    const { container } = renderPlayer();
    tapControl(container);
    expect(container.querySelector(".ugoira-spinner")).toBeTruthy();
    // While loading the control is disabled by the player's own guard —
    // a second toggle must not double-fire loads.
    tapControl(container);
    resolveMeta!(META);
    await flushMicrotasks();
    expect(statusText(container)).toBe("playing");
    expect(mockedApi.getUgoiraMeta).toHaveBeenCalledTimes(1);
  });

  it("zip fetch failure shows the retry badge; tapping retries the load", async () => {
    installFetchMock({ ok: false, status: 502 });
    const { container } = renderPlayer();
    await playThroughExpectError(container);
    expect(mockedApi.getUgoiraMeta).toHaveBeenCalledTimes(1);
    // Tap the badge: idle-after-error retries.
    fireEvent.click(container.querySelector(".ugoira-badge")!);
    await flushMicrotasks();
    expect(mockedApi.getUgoiraMeta).toHaveBeenCalledTimes(2);
  });

  it("a frame missing from the zip surfaces the error badge", async () => {
    zipBytes = makeZip({ "000000.jpg": new Uint8Array([1]) });
    const { container } = renderPlayer();
    await playThroughExpectError(container);
    // The canvas stays mounted; the badge signals the failure.
    expect(visibleCanvas(container)).toBeTruthy();
    expect(container.querySelector(".ugoira-badge")).toBeTruthy();
  });

  it("a stalled zip download is aborted after the deadline and shows the error badge", async () => {
    installFetchMock({ stall: true });
    const { container } = renderPlayer();
    tapControl(container);
    expect(container.querySelector(".ugoira-spinner")).toBeTruthy();
    vi.advanceTimersByTime(120_001);
    await flushMicrotasks();
    expect(container.querySelector(".ugoira-badge")).toBeTruthy();
    // fetchCalls[0] = static poster (15s abort), [1] = frame zip (120s).
    expect(fetchCalls[1].signal!.aborted).toBe(true);
  });

  it("scroll-away tears the player down: idle again, frames freed", async () => {
    const { container } = renderPlayer();
    await playThrough(container);
    scrollAway();
    // The canvas stays mounted; the player reports idle again.
    expect(visibleCanvas(container)).toBeTruthy();
    expect(statusText(container)).toBe("idle");
  });

  it("an in-flight load discards itself after scroll-away (seq guard)", async () => {
    let resolveMeta!: (v: unknown) => void;
    mockedApi.getUgoiraMeta.mockImplementationOnce(
      () => new Promise((r) => (resolveMeta = r))
    );
    const { container } = renderPlayer();
    tapControl(container);
    scrollAway();
    // Teardown aborts the pending static + zip controllers; the seq bump
    // dooms any load that still completes.
    resolveMeta!(META);
    await flushMicrotasks();
    expect(visibleCanvas(container)).toBeTruthy(); // poster canvas stays
    expect(statusText(container)).toBe("idle");
    expect(fetchCalls[0].signal!.aborted).toBe(true);
  });

  it("the wrap has no click handler - image taps belong to the card", () => {
    const { container } = renderPlayer();
    expect(wrapEl(container).getAttribute("role")).toBeNull();
    expect(wrapEl(container).getAttribute("tabindex")).toBeNull();
  });
});
