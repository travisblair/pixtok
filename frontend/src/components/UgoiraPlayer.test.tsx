import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { http, HttpResponse } from "msw";
import UgoiraPlayer from "./UgoiraPlayer";
import {
  requestCount,
  requestParams,
  requestsTo,
  server,
} from "../test/msw/server";
import { ONE_PX_PNG, ugoiraMeta, ugoiraZip } from "../test/msw/handlers";

/**
 * UgoiraPlayer unit tests.
 *
 * Network: the REAL api/search.getUgoiraMeta + api/client.logEvent run
 * against the shared MSW fixture — /api/illust/7701/ugoira_meta
 * (validated, fixture payload), the /api/img proxy (real zip bytes for
 * the ugoira archive, the 1×1 PNG poster otherwise) and /api/log
 * breadcrumbs. Assertions are wire-level: request counts / ?url= params
 * for the API, decoded POSTed breadcrumbs for the journal.
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
 * Fake timers: ONLY setTimeout/clearTimeout are faked (the step loop +
 * the 60s/120s download deadlines). MSW's own pipeline (headers, then
 * the body stream) resolves purely on microtasks, so waits pump
 * microtasks instead of touching the clock. waitFor is unusable here:
 * it schedules real timers the fake clock never fires, and advancing
 * the clock mid-load would let the frame timer fire and make draw
 * counts nondeterministic.
 *
 * Interaction model (Aug 2026): the play/pause CONTROL lives in the
 * card overlay (FeedCard), driven by a counter signal handed to the
 * player; the player reports status back. Image taps fall through to
 * the card and open the related stack — the wrap has no click handler.
 */

const STATIC_URL = "https://i.pximg.net/img-original/static.jpg";
const META_PATH = "/api/illust/7701/ugoira_meta";
/** The meta handler's default payload (frames 000000/000001, 100/200ms). */
const META = ugoiraMeta(7701);
const ZIP_TARGET = META.body.src;

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

// ── MSW helpers ────────────────────────────────────────────────────────

/** ?url= targets of every /api/img request so far, in arrival order. */
function imageTargets(): string[] {
  return requestParams("/api/img").map((p) => p.url ?? "");
}

/**
 * Pump microtasks WITHOUT advancing fake timers. MSW needs on the order
 * of a hundred turns per hop (match → headers → body stream) and the
 * load chain is several hops; the count is generous so a slow hop can't
 * flake, while a stuck one still fails instead of hanging.
 */
async function flushMicrotasks(n = 400) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** Pump microtasks until `check` holds — the fake-timer-safe waitFor. */
async function pumpUntil(check: () => boolean, label: string, max = 5000) {
  for (let i = 0; i < max; i++) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error(
    `pumpUntil: "${label}" never became true within ${max} microtask turns`
  );
}

type Breadcrumb = { scope: string; msg: string; data?: Record<string, unknown> };

/** Decoded /api/log breadcrumbs POSTed this test, in arrival order. */
async function breadcrumbs(): Promise<Breadcrumb[]> {
  return Promise.all(
    requestsTo("/api/log").map((r) => r.json() as Promise<Breadcrumb>)
  );
}

/** Wait for the fire-and-forget breadcrumb with `msg` to land + decode. */
async function breadcrumb(msg: string): Promise<Breadcrumb> {
  for (let i = 0; i < 400; i++) {
    const hit = (await breadcrumbs()).find((b) => b.msg === msg);
    if (hit) return hit;
    await Promise.resolve();
  }
  throw new Error(`no /api/log breadcrumb with msg "${msg}"`);
}

/** Replace the ugoira_meta handler with a custom frame list. */
function serveMeta(frames: { file: string; delay: number }[]) {
  server.use(
    http.get(META_PATH, () => HttpResponse.json(ugoiraMeta(7701, frames)))
  );
}

/**
 * /api/img override mirroring the shared handler's bytes (zip for the
 * ugoira archive, the 1×1 PNG poster otherwise) that also records which
 * downloads the CLIENT aborted — the wire-level stand-in for the old
 * fetch-mock's signal.aborted assertions. `stall: true` simulates a
 * relay that never completes, so only a client deadline (or a teardown)
 * ends the request.
 */
function serveImages(opts: { zip?: Uint8Array; stall?: boolean } = {}) {
  const seen: string[] = [];
  const aborted: string[] = [];
  server.use(
    http.get("/api/img", async ({ request }) => {
      const target = new URL(request.url).searchParams.get("url") ?? "";
      seen.push(target);
      const note = () => aborted.push(target);
      // An abort can land before MSW runs the resolver — MSW then
      // short-circuits the request and we never see it.
      if (request.signal.aborted) note();
      else request.signal.addEventListener("abort", note, { once: true });
      if (opts.stall) await new Promise(() => {});
      if (target.includes("img-zip-ugoira")) {
        return new HttpResponse(opts.zip ?? ugoiraZip(), {
          headers: { "Content-Type": "application/zip" },
        });
      }
      return new HttpResponse(ONE_PX_PNG, {
        headers: { "Content-Type": "image/png" },
      });
    })
  );
  return { seen, aborted };
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
        staticUrl={STATIC_URL}
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Shared helper: play through to the playing state. */
async function playThrough(container: HTMLElement) {
  tapControl(container);
  await pumpUntil(
    () => statusText(container) === "playing",
    "status playing"
  );
}

/** Shared helper: play through to the error badge state. */
async function playThroughExpectError(container: HTMLElement) {
  tapControl(container);
  await pumpUntil(
    () => container.querySelector(".ugoira-badge") !== null,
    "error badge"
  );
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
    expect(requestCount(META_PATH)).toBe(0);
    // Exactly ONE request on mount: the static poster frame.
    await pumpUntil(() => requestCount("/api/img") >= 1, "poster request");
    expect(imageTargets()).toEqual([STATIC_URL]);
  });

  it("toggle -> spinner -> playing on the canvas; status reports back", async () => {
    const { container } = renderPlayer();
    tapControl(container);
    expect(container.querySelector(".ugoira-spinner")).toBeTruthy();
    await pumpUntil(
      () => statusText(container) === "playing",
      "status playing"
    );
    expect(container.querySelector(".ugoira-spinner")).toBeNull();
    expect(requestCount(META_PATH)).toBe(1);
    // First /api/img request = static poster (discarded once playback
    // wins), second = the frame zip.
    await pumpUntil(() => imageTargets().length >= 2, "zip request");
    expect(imageTargets()).toEqual([STATIC_URL, ZIP_TARGET]);
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
          staticUrl={STATIC_URL}
          title="うごイラ"
          toggleSignal={sig()}
          maxFrameSide={360}
          maxPosterSide={720}
        />
      </>
    ));
    tapControl(container);
    await pumpUntil(
      () => canvasesInCreationOrder.length >= 3 && !container.querySelector(".ugoira-spinner"),
      "frames loaded"
    );

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
    await vi.advanceTimersByTimeAsync(199);
    expect(draws).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(draws).toHaveBeenCalledTimes(3);
    expect(draws.mock.calls[2][0]).toBe(f0);
    // Frame 0's delay is 100ms.
    await vi.advanceTimersByTimeAsync(100);
    expect(draws).toHaveBeenCalledTimes(4);
    expect(draws.mock.calls[3][0]).toBe(f1);
  });

  it("clamps tiny delays to a 20ms floor", async () => {
    serveMeta([
      { file: "000000.jpg", delay: 5 },
      { file: "000001.jpg", delay: 1 },
    ]);
    const { container } = renderPlayer();
    await playThrough(container);
    tapControl(container); // pause
    tapControl(container); // resume - schedules with the clamped floor
    const draws = visibleDraws(container);
    // frame 0 + resume's frame 1
    expect(draws).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(draws).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(draws).toHaveBeenCalledTimes(3);
  });

  it("a delay of 0 falls back to the 60ms default", async () => {
    serveMeta([{ file: "000000.jpg", delay: 0 }]);
    const { container } = renderPlayer();
    await playThrough(container);
    tapControl(container); // pause
    tapControl(container); // resume - schedules with the 60ms default
    const draws = visibleDraws(container);
    // frame 0 + resume's draw (single-frame loop)
    expect(draws).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59);
    expect(draws).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(draws).toHaveBeenCalledTimes(3);
  });

  it("pause freezes the canvas; no stepping while paused", async () => {
    const { container } = renderPlayer();
    await playThrough(container);
    tapControl(container); // pause
    expect(statusText(container)).toBe("paused");
    expect(visibleCanvas(container)).toBeTruthy(); // frozen frame stays
    const before = visibleDraws(container).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(visibleDraws(container).mock.calls.length).toBe(before);
  });

  it("a second toggle during loading is ignored (no duplicate meta fetches)", async () => {
    let releaseMeta!: () => void;
    const metaGate = new Promise<void>((r) => (releaseMeta = r));
    server.use(
      http.get(META_PATH, async () => {
        await metaGate;
        return HttpResponse.json(META);
      })
    );
    const { container } = renderPlayer();
    tapControl(container);
    expect(container.querySelector(".ugoira-spinner")).toBeTruthy();
    // While loading the control is disabled by the player's own guard —
    // a second toggle must not double-fire loads.
    tapControl(container);
    await pumpUntil(() => requestCount(META_PATH) >= 1, "meta request");
    releaseMeta();
    await pumpUntil(
      () => statusText(container) === "playing",
      "status playing"
    );
    expect(requestCount(META_PATH)).toBe(1);
  });

  it("zip fetch failure shows the retry badge; tapping retries the load", async () => {
    server.use(
      http.get(
        "/api/img",
        () => new HttpResponse("upstream error\n", { status: 502 })
      )
    );
    const { container } = renderPlayer();
    await playThroughExpectError(container);
    expect(requestCount(META_PATH)).toBe(1);
    // Tap the badge: idle-after-error retries.
    fireEvent.click(container.querySelector(".ugoira-badge")!);
    await pumpUntil(() => requestCount(META_PATH) >= 2, "meta retry");
    expect(requestCount(META_PATH)).toBe(2);
  });

  it("a frame missing from the zip surfaces the error badge", async () => {
    serveImages({ zip: ugoiraZip({ "000000.jpg": new Uint8Array([1]) }) });
    const { container } = renderPlayer();
    await playThroughExpectError(container);
    // The canvas stays mounted; the badge signals the failure — and the
    // breadcrumb names the missing frame, so the badge can't be a
    // poster/download failure in disguise.
    expect(visibleCanvas(container)).toBeTruthy();
    expect(container.querySelector(".ugoira-badge")).toBeTruthy();
    const crumb = await breadcrumb("fail");
    expect(crumb.data?.err).toContain("missing frame 000001.jpg");
  });

  it("a stalled zip download is aborted after the deadline and shows the error badge", async () => {
    const images = serveImages({ stall: true });
    const { container } = renderPlayer();
    tapControl(container);
    expect(container.querySelector(".ugoira-spinner")).toBeTruthy();
    // Poster + zip are both in flight (their handlers hold the signals).
    await pumpUntil(() => images.seen.includes(ZIP_TARGET), "zip in flight");
    // 60s: the poster's deadline aborts it. Silent BY DESIGN — the tap
    // superseded it (loadSeq bump), so its late timeout must not badge a
    // card whose zip load owns the UI.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(container.querySelector(".ugoira-badge")).toBeNull();
    expect(images.aborted).toContain(STATIC_URL);
    // 120s: the zip deadline aborts the stalled download → badge + a
    // real failure breadcrumb (the pre-fix code spun forever here).
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpUntil(
      () => container.querySelector(".ugoira-badge") !== null,
      "error badge"
    );
    expect(images.aborted).toContain(ZIP_TARGET);
    const crumb = await breadcrumb("zip-timeout");
    expect(crumb).toMatchObject({ scope: "ugoira", data: { id: 7701 } });
    // The poster's 60s abort logged nothing.
    expect(
      (await breadcrumbs()).filter((b) => b.msg === "poster-timeout")
    ).toHaveLength(0);
  });

  it("a stalled poster alone is badged at its 60s deadline", async () => {
    const images = serveImages({ stall: true });
    const { container } = renderPlayer();
    expect(container.querySelector(".ugoira-badge")).toBeNull();
    await pumpUntil(
      () => images.seen.includes(STATIC_URL),
      "poster in flight"
    );
    await vi.advanceTimersByTimeAsync(60_001);
    await pumpUntil(
      () => container.querySelector(".ugoira-badge") !== null,
      "error badge"
    );
    const crumb = await breadcrumb("poster-timeout");
    expect(crumb).toMatchObject({ scope: "ugoira", data: { id: 7701 } });
    // No tap: the meta hop was never requested, and only the poster
    // download was aborted.
    expect(requestCount(META_PATH)).toBe(0);
    expect(images.aborted).toEqual([STATIC_URL]);
  });

  it("a successful playback posts start and ok breadcrumbs", async () => {
    const { container } = renderPlayer();
    await playThrough(container);
    await breadcrumb("ok");
    const all = await breadcrumbs();
    expect(all.find((b) => b.msg === "start")).toMatchObject({
      scope: "ugoira",
      data: { id: 7701 },
    });
    expect(all.find((b) => b.msg === "ok")).toMatchObject({
      scope: "ugoira",
      data: { id: 7701, frames: 2 },
    });
  });

  it("a zip fetch failure posts a fail breadcrumb naming the error", async () => {
    server.use(
      http.get(
        "/api/img",
        () => new HttpResponse("upstream error\n", { status: 502 })
      )
    );
    const { container } = renderPlayer();
    await playThroughExpectError(container);
    const crumb = await breadcrumb("fail");
    expect(crumb.data?.err).toContain("502");
  });

  it("scroll-away during an in-flight load posts an aborted breadcrumb", async () => {
    // The meta hop never answers, so the zip stage is the one in flight
    // when the card scrolls away.
    server.use(
      http.get(META_PATH, async () => {
        await new Promise(() => {});
      })
    );
    const { container } = renderPlayer();
    tapControl(container);
    scrollAway();
    const crumb = await breadcrumb("aborted");
    expect(crumb).toMatchObject({
      scope: "ugoira",
      data: { id: 7701, stage: "zip", reason: "teardown" },
    });
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
    const images = serveImages({ stall: true });
    let releaseMeta!: () => void;
    const metaGate = new Promise<void>((r) => (releaseMeta = r));
    server.use(
      http.get(META_PATH, async () => {
        await metaGate;
        return HttpResponse.json(META);
      })
    );
    const { container } = renderPlayer();
    tapControl(container);
    // The poster download is genuinely in flight when the card scrolls
    // away; teardown aborts the pending static + zip controllers, and the
    // seq bump dooms any load that still completes.
    await pumpUntil(
      () => images.seen.includes(STATIC_URL),
      "poster in flight"
    );
    scrollAway();
    expect(images.aborted).toContain(STATIC_URL);
    releaseMeta();
    await flushMicrotasks();
    expect(visibleCanvas(container)).toBeTruthy(); // poster canvas stays
    expect(statusText(container)).toBe("idle");
  });

  it("the wrap has no click handler - image taps belong to the card", () => {
    const { container } = renderPlayer();
    expect(wrapEl(container).getAttribute("role")).toBeNull();
    expect(wrapEl(container).getAttribute("tabindex")).toBeNull();
  });
});
