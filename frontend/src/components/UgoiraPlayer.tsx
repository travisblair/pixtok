import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { unzip, type Unzipped } from "fflate";
import { api } from "../api";

/**
 * Canvas-based ugoira player, mirroring how pixiv.net does it: fetch
 * ugoira_meta (frame list + per-frame delays), fetch the frame zip
 * through the image proxy, inflate in-memory (fflate), and step through
 * the frames on a canvas honouring each frame's delay.
 *
 * The canvas is the ONLY surface — there is no poster <img>. On mount the
 * static frame is fetched and drawn onto the canvas (downscaled to the
 * same budget as animation frames); the ▶ button sits on that canvas.
 * Tapping ▶ loads meta + zip (spinner while loading) and starts the loop
 * — frame 0 replaces the poster on the same canvas with identical pixels,
 * so there is no img→canvas swap and no visible jump. Tapping again
 * pauses (▶ returns over the frozen frame), a third tap resumes.
 *
 * Interaction model: ONLY the control button drives playback — it
 * stopPropagation's its taps. Taps anywhere else on the image fall
 * through to the card, which opens the related-work stack like any other
 * card. Scroll-away frees the decoded frames but keeps the poster frame
 * on the canvas.
 *
 * Performance notes (reviewer findings):
 * - Decompression is the ASYNC fflate unzip() — the sync form froze the
 *   main thread for multi-MB archives (visible jank on tap).
 * - Frame canvases are DOWNSCALED to at most MAX_FRAME_SIDE device px.
 *   Native-res frames (1200×1200 RGBA ≈ 5.7 MB) × 50 frames ≈ 288 MB —
 *   an instant iOS jetsam kill. The card is ~400 CSS px wide; 800 px
 *   is visually identical and cuts per-frame memory ~4x. The poster
 *   frame goes through the same downscale.
 */
type PlayerStatus = "idle" | "loading" | "playing" | "paused";

const MAX_FRAME_SIDE = 800;

export default function UgoiraPlayer(props: {
  illustId: number;
  staticUrl: string;
  title: string;
}) {
  const [status, setStatus] = createSignal<PlayerStatus>("idle");
  const [error, setError] = createSignal(false);
  const [posterReady, setPosterReady] = createSignal(false);

  let canvasRef: HTMLCanvasElement | undefined;
  let rootRef: HTMLDivElement | undefined;
  let frames: HTMLCanvasElement[] = [];
  let delays: number[] = [];
  let staticFrame: HTMLCanvasElement | null = null; // downscaled poster frame
  let staticLoading = false;
  let idx = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loadSeq = 0; // bumped on teardown — in-flight loads discard themselves
  let zipAbort: AbortController | undefined; // kills the in-flight zip fetch
  let staticAbort: AbortController | undefined; // kills the in-flight poster fetch

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function drawStatic() {
    if (!canvasRef || !staticFrame) return;
    const canvas = canvasRef;
    canvas.width = staticFrame.width;
    canvas.height = staticFrame.height;
    // getContext may be gone at unmount (test teardown restores mocks
    // before Solid's onCleanup runs) — never crash in cleanup paths.
    canvas.getContext("2d")?.drawImage(staticFrame, 0, 0);
  }

  function teardown() {
    loadSeq++;
    zipAbort?.abort(); // stop a multi-MB zip download that's no longer needed
    zipAbort = undefined;
    staticAbort?.abort();
    staticAbort = undefined;
    clearTimer();
    frames = [];
    delays = [];
    drawStatic(); // the poster frame (frame 0) stays on the canvas
    setStatus("idle");
    setError(false);
  }

  async function loadStatic() {
    if (staticFrame || staticLoading) return;
    const seq = ++loadSeq;
    staticLoading = true;
    setError(false);
    const controller = new AbortController();
    staticAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(
        `/api/img?url=${encodeURIComponent(props.staticUrl)}`,
        { signal: controller.signal }
      );
      if (!res.ok) throw new Error(`static fetch failed: ${res.status}`);
      const blob = await res.blob();
      const frame = await loadFrame(blob);
      if (seq !== loadSeq) return; // torn down or superseded while fetching
      staticFrame = frame;
      drawStatic();
      setPosterReady(true);
    } catch (e) {
      console.error("ugoira static load failed:", e);
      if (seq === loadSeq) setError(true);
    } finally {
      clearTimeout(timeout);
      staticLoading = false;
      if (staticAbort === controller) staticAbort = undefined;
    }
  }

  async function loadFrames() {
    const seq = ++loadSeq;
    setStatus("loading");
    setError(false);
    const controller = new AbortController();
    zipAbort = controller;
    // The zip can be several MB — a stalled connection must not keep
    // burning cellular data forever.
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const meta = await api.getUgoiraMeta(props.illustId);
      const body = meta.body;

      const zipRes = await fetch(`/api/img?url=${encodeURIComponent(body.src)}`, {
        signal: controller.signal,
      });
      if (!zipRes.ok) throw new Error(`zip fetch failed: ${zipRes.status}`);
      const zipBuf = await zipRes.arrayBuffer();

      if (seq !== loadSeq) return; // torn down while fetching
      // fflate 0.8.x's async unzip is callback-based — wrap it so the
      // decompression work yields to the event loop (the sync form
      // froze the UI thread for multi-MB archives).
      const unzipped = await new Promise<Unzipped>((resolve, reject) => {
        unzip(new Uint8Array(zipBuf), (err, res) => {
          if (err) reject(err);
          else resolve(res);
        });
      });

      const mime = body.mime_type || "image/jpeg";
      const loaded = await Promise.all(
        body.frames.map((f) => {
          const data = unzipped[f.file];
          if (!data) throw new Error(`missing frame ${f.file}`);
          return loadFrame(new Blob([data], { type: mime }));
        })
      );
      if (seq !== loadSeq) return;

      frames = loaded;
      delays = body.frames.map((f) => Math.max(20, f.delay || 60));
      idx = 0;
      // step() draws frame 0 in the same tick — identical pixels to the
      // poster already on the canvas, so there's no visible jump.
      setStatus("playing");
      step();
    } catch (e) {
      console.error("ugoira load failed:", e);
      if (seq === loadSeq) {
        setStatus("idle");
        setError(true);
      }
    } finally {
      clearTimeout(timeout);
      if (zipAbort === controller) zipAbort = undefined;
    }
  }

  function loadFrame(blob: Blob): Promise<HTMLCanvasElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        // Downscale to the display budget (reviewer finding): the
        // visible canvas never needs the source resolution.
        const scale = Math.min(
          1,
          MAX_FRAME_SIDE / Math.max(img.naturalWidth, img.naturalHeight)
        );
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("frame decode failed"));
      };
      img.src = url;
    });
  }

  function drawFrame(i: number) {
    if (!canvasRef || frames.length === 0) return;
    const canvas = canvasRef;
    const frame = frames[i % frames.length];
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext("2d")?.drawImage(frame, 0, 0);
  }

  function step() {
    if (status() !== "playing") return; // plain read — timer callback, no tracking
    if (!canvasRef || frames.length === 0) return;
    drawFrame(idx);
    idx = (idx + 1) % frames.length;
    timer = setTimeout(step, delays[(idx - 1 + delays.length) % delays.length]);
  }

  function toggle(e: Event) {
    // The control button owns its taps — the card must NOT push a
    // related stack on play/pause.
    e.stopPropagation();
    e.preventDefault();
    const s = status();
    if (s === "loading") return;
    if (s === "playing") {
      clearTimer();
      setStatus("paused"); // frozen frame stays on canvas; ▶ returns
      return;
    }
    if (s === "paused") {
      setStatus("playing");
      step(); // resume from the current frame
      return;
    }
    // idle — or idle after an error (tap retries poster + frames)
    void loadFrames();
    if (!staticFrame) void loadStatic();
  }

  // Scrolled away → freeze + free the frame set (the poster frame stays
  // on the canvas). Re-entering retries the poster if it never loaded.
  onMount(() => {
    const root = rootRef?.closest<HTMLElement>(".feed-container") ?? null;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          teardown();
        } else if (!staticFrame) {
          void loadStatic();
        }
      },
      { root, rootMargin: "0px" }
    );
    if (rootRef) io.observe(rootRef);
    void loadStatic();
    onCleanup(() => {
      io.disconnect();
      teardown();
    });
  });

  const controlShown = () =>
    (status() === "idle" || status() === "paused" || status() === "playing") &&
    !error();

  return (
    <div class="ugoira-wrap" ref={rootRef}>
      <canvas
        ref={canvasRef}
        class={"ugoira-canvas" + (posterReady() ? " ready" : "")}
        aria-hidden="true"
      />
      <Show when={controlShown()}>
        <button
          type="button"
          class={"ugoira-play" + (status() === "playing" ? " pause" : "")}
          onClick={toggle}
          aria-label={status() === "playing" ? "Pause animation" : "Play animation"}
        >
          <Show when={status() === "playing"} fallback={"▶"}>
            <span class="ugoira-pause-bars" aria-hidden="true">
              <span />
              <span />
            </span>
          </Show>
        </button>
      </Show>
      <Show when={status() === "loading"}>
        <div class="ugoira-spinner" aria-hidden="true" />
      </Show>
      <Show when={error()}>
        <button
          type="button"
          class="ugoira-badge overlay-pill ugoira-error"
          onClick={toggle}
        >
          ⚠️ tap to retry
        </button>
      </Show>
    </div>
  );
}
