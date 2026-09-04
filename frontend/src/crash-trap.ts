// Crash trap: a sessionStorage ring buffer that survives reloads and
// captures uncaught errors + unhandled rejections, then uploads them to
// /api/log (scope "crash") on the next successful boot. iOS Safari can
// kill the page (jetsam) with no console anywhere — the ring is the only
// record the Pi journal gets of a client-side crash. Deliberately tiny
// and inert: nothing here may ever throw or depend on app state.

import { logEvent } from "./api/client";

const KEY = "pixtok_crash_ring";
const MAX = 6;
const MSG_CAP = 140;
const STACK_CAP = 220;
const URL_CAP = 80;

interface CrashEntry {
  t: number;
  kind: "error" | "rejection";
  m: string;
  s?: string;
  u?: string;
  l?: number;
  c?: number;
}

function read(): CrashEntry[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CrashEntry[]) : [];
  } catch {
    return [];
  }
}

function write(entries: CrashEntry[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    try {
      // full: drop the oldest entry and retry once
      sessionStorage.setItem(KEY, JSON.stringify(entries.slice(1)));
    } catch {
      // genuinely out of space — stay silent
    }
  }
}

function record(
  kind: CrashEntry["kind"],
  m: unknown,
  s?: string,
  u?: string,
  l?: number,
  c?: number,
) {
  const msg = String(m ?? "unknown error").slice(0, MSG_CAP);
  const stack = s ? s.slice(0, STACK_CAP) : undefined;
  const url = u ? u.slice(0, URL_CAP) : undefined;
  const entries = read();
  const last = entries[entries.length - 1];
  // Crash loops repeat the same error every reload — keep the ring
  // informative, not flooded with one message. Match on kind + message +
  // URL only: stacks legitimately differ per call site, and the point is
  // spam control, not stack forensics.
  if (last && last.kind === kind && last.m === msg && last.u === url) return;
  write([
    ...entries.slice(-(MAX - 1)),
    { t: Date.now(), kind, m: msg, s: stack, u: url, l, c },
  ]);
}

let installed = false;

/** Attach the global listeners. Call once, before the app mounts. */
export function installCrashTrap() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (ev: ErrorEvent) => {
    if (ev.error instanceof Error && ev.error.name === "AbortError") return;
    record("error", ev.message, ev.error instanceof Error ? ev.error.stack : undefined,
      ev.filename, ev.lineno, ev.colno);
  });
  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const r: unknown = ev.reason;
    if (r instanceof Error) {
      if (r.name === "AbortError") return; // aborted fetches are normal life
      record("rejection", r.message, r.stack);
      return;
    }
    try {
      record("rejection", typeof r === "string" ? r : JSON.stringify(r));
    } catch {
      record("rejection", "unserializable rejection");
    }
  });
}

/**
 * Post any ring contents to the journal, then clear the ring. Clear FIRST:
 * a crash mid-upload must not resurrect the same entries next boot.
 */
export function uploadCrashBuffer() {
  const entries = read();
  if (entries.length === 0) return;
  write([]);
  for (const e of entries) {
    logEvent("crash", e.kind, { t: e.t, m: e.m, s: e.s, u: e.u, l: e.l, c: e.c });
  }
}
