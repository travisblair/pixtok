const BASE = "/api";

/**
 * Backend feeds emit illust ids inconsistently: the web-AJAX transforms
 * (street/top/recs) marshal ids as JSON strings, while the app-API
 * passthroughs (recommended/related/next) carry numeric ids. Normalize
 * every illust id + user id to number here so the whole frontend — the
 * dedupe set, related-view comparisons, like/unlike calls — sees ONE
 * wire contract.
 */
function normalizeIllustIds(items: unknown[] | undefined) {
  if (!items) return;
  for (const item of items) {
    const ill = item as { id?: string | number; user?: { id?: string | number } };
    if (ill && typeof ill.id === "string") {
      const n = Number(ill.id);
      // Reviewer finding: never store a lossy number. Ids beyond
      // Number.MAX_SAFE_INTEGER keep their exact string form.
      if (Number.isSafeInteger(n)) ill.id = n;
    }
    if (ill && ill.user && typeof ill.user.id === "string") {
      const n = Number(ill.user.id);
      if (Number.isSafeInteger(n)) ill.user.id = n;
    }
  }
}

function normalizeIds(data: unknown): unknown {
  const feed = data as {
    illusts?: unknown[];
    popular?: unknown[];
    users?: unknown[];
  } | null;
  if (!feed) return data;
  normalizeIllustIds(feed.illusts);
  normalizeIllustIds(feed.popular);
  if (Array.isArray(feed.users)) {
    for (const u of feed.users) {
      const user = u as { id?: string | number; previews?: unknown[] };
      if (user && typeof user.id === "string") {
        const n = Number(user.id);
        if (Number.isSafeInteger(n)) user.id = n;
      }
      normalizeIllustIds(user.previews);
    }
  }
  return feed;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch (err) {
    // AbortError = superseded by a newer request (like double-taps) —
    // not a failure. Timeouts and network drops surface in the toast.
    const name = abortName(err);
    if (name === "TimeoutError") onRequestError?.("Request timed out");
    else if (name !== "AbortError") onRequestError?.("Network error");
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Mid-session gate re-lock: the app boots unlocked, then the gate
    // cookie leaves the client (iOS Safari eviction, private-mode
    // teardown, profile switch). Gate status is only checked at boot,
    // so without this every subsequent view degrades into a silent
    // empty/error state — hidden follow buttons, dead feeds. Surface
    // the GateScreen instead (App registers the listener on mount).
    if (res.status === 403 && text.includes("gate locked")) {
      onGateLocked?.();
    } else {
      // Every other failure surfaces in the red error toast (2s, tap
      // to dismiss) — a failed feed, follow state, or like should
      // never pass silently.
      onRequestError?.(`Request failed (${res.status})`);
    }
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  try {
    const data = await res.json();
    return normalizeIds(data) as T;
  } catch (err) {
    onRequestError?.("Bad response");
    throw err;
  }
}

function abortName(err: unknown): string | null {
  return typeof err === "object" && err !== null && "name" in err
    ? String((err as { name?: unknown }).name)
    : null;
}

// Listener for mid-session gate re-locks (see request()). App registers
// it on mount and clears it on cleanup; kept out of the api object so
// request() can call it without a circular reference.
let onGateLocked: (() => void) | null = null;

export function setOnGateLocked(handler: (() => void) | null) {
  onGateLocked = handler;
}

// Listener for request failures (see request()). App renders the red
// top error toast; gate locks and superseded-request aborts are the
// only failures that stay silent here (they have their own UX).
let onRequestError: ((message: string) => void) | null = null;

export function setOnRequestError(handler: ((message: string) => void) | null) {
  onRequestError = handler;
}

// Client session id: tags breadcrumb events so one page load's story
// can be reconstructed from the server journal (the phone has no
// DevTools — the journal IS the console).
const CLIENT_SESSION = Math.random().toString(36).slice(2, 8);

/**
 * Fire-and-forget breadcrumb to the backend journal (POST /api/log).
 * Deliberately NOT request(): a logging failure must never surface in
 * the error toast or the gate-lock flow, and never throw.
 */
export function logEvent(scope: string, msg: string, data?: unknown) {
  try {
    void fetch(`${BASE}/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: CLIENT_SESSION, scope, msg, data }),
    }).catch(() => {
      // breadcrumb delivery is best-effort; silence is fine
    });
  } catch {
    // logging must never break the app
  }
}
