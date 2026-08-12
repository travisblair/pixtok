import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { unzipSync } from "fflate";
import { api } from "../api";

/**
 * Canvas-based ugoira player, mirroring how pixiv.net does it: fetch
 * ugoira_meta (frame list + per-frame delays), fetch the frame zip
 * through the image proxy, inflate in-memory (fflate), and step through
 * the frames on a canvas honouring each frame's delay.
 *
 * Playback is MANUAL — the card shows a play icon over the static frame;
 * tapping loads meta + zip (spinner while loading) and starts the loop;
 * tapping again pauses (icon returns), tapping a third time resumes.
 * Scroll-away tears everything down (ugoira zips run several MB — never
 * let a scrolled-past card keep 100+ decoded frames alive).
 */
type PlayerStatus = "idle" | "loading" | "playing" | "paused";

export default function UgoiraPlayer(props: {
  illustId: number;
  staticUrl: string;
  title: string;
}) {
  const [status, setStatus] = createSignal<PlayerStatus>("idle");
  const [error, setError] = createSignal(false);

  let canvasRef: HTMLCanvasElement | undefined;
  let rootRef: HTMLDivElement | undefined;
  let frames: HTMLCanvasElement[] = [];
  let delays: number[] = [];
  let idx = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loadSeq = 0; // bumped on teardown — in-flight loads discard themselves
  let zipAbort: AbortController | undefined; // kills the in-flight zip fetch

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function teardown() {
    loadSeq++;
    zipAbort?.abort(); // stop a multi-MB zip download that's no longer needed
    zipAbort = undefined;
    clearTimer();
    frames = [];
    delays = [];
    setStatus("idle");
    setError(false);
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
      const unzipped = unzipSync(new Uint8Array(zipBuf));

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
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d")!.drawImage(img, 0, 0);
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

  function step() {
    if (status() !== "playing") return; // plain read — timer callback, no tracking
    if (!canvasRef || frames.length === 0) return;
    const canvas = canvasRef;
    const frame = frames[idx % frames.length];
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext("2d")!.drawImage(frame, 0, 0);
    idx = (idx + 1) % frames.length;
    timer = setTimeout(step, delays[(idx - 1 + delays.length) % delays.length]);
  }

  function toggle(e: Event) {
    // Owns its taps — the card must NOT push a related stack on play/pause.
    e.stopPropagation();
    e.preventDefault();
    const s = status();
    if (s === "loading") return;
    if (s === "playing") {
      clearTimer();
      setStatus("paused"); // frozen frame stays on canvas; play icon returns
      return;
    }
    if (s === "paused") {
      setStatus("playing");
      step(); // resume from the current frame
      return;
    }
    // idle — or idle after an error (tap retries the load)
    void loadFrames();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    toggle(e);
  }

  // Scrolled away → freeze + free everything. Re-entering shows the play
  // icon again; the next tap reloads (zip comes from the HTTP cache).
  onMount(() => {
    const root = rootRef?.closest<HTMLElement>(".feed-container") ?? null;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) teardown();
      },
      { root, rootMargin: "0px" }
    );
    if (rootRef) io.observe(rootRef);
    onCleanup(() => {
      io.disconnect();
      teardown();
    });
  });

  // Canvas visible while playing OR paused (frozen frame stays on screen).
  const activeCanvas = () => status() === "playing" || status() === "paused";

  return (
    <div
      class="ugoira-wrap"
      ref={rootRef}
      onClick={toggle}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
      aria-label={status() === "playing" ? "Pause animation" : "Play animation"}
    >
      <img
        class="card-image loaded"
        src={`/api/img?url=${encodeURIComponent(props.staticUrl)}`}
        alt={props.title}
      />
      <Show when={activeCanvas()}>
        <canvas ref={canvasRef} class="ugoira-canvas" aria-hidden="true" />
      </Show>
      <Show when={(status() === "idle" || status() === "paused") && !error()}>
        <div class="ugoira-play" aria-hidden="true">▶</div>
      </Show>
      <Show when={status() === "loading"}>
        <div class="ugoira-spinner" aria-hidden="true" />
      </Show>
      <Show when={error()}>
        <div class="ugoira-badge overlay-pill ugoira-error">⚠️ tap to retry</div>
      </Show>
    </div>
  );
}
