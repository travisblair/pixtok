import { request } from "./client";

// Preference writes serialize through this queue (reviewer finding:
// rapid PUTs can complete out of order — ["a"], ["a","b","c"], ["a","b"]
// — leaving the DB at a stale state). Chaining guarantees the last
// issued write is the last applied. Errors don't break the chain.
let prefsWriteQueue: Promise<unknown> = Promise.resolve();
function queuedPrefWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = prefsWriteQueue.then(fn, fn);
  prefsWriteQueue = run.catch(() => {});
  return run;
}

// Blocked tags live in the backend prefs DB (localStorage proved
// unreliable on iOS).
export function getBlockedTags() {
  return request<{ tags: string[] }>("/prefs/blocked-tags", {
    signal: AbortSignal.timeout(10_000),
  });
}

export async function setBlockedTags(tags: string[]) {
  await queuedPrefWrite(() =>
    request<{ tags: string[] }>("/prefs/blocked-tags", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(10_000),
    })
  );
}

export function getImageSize() {
  return request<{ value: "large" | "medium" }>("/prefs/image-size", {
    signal: AbortSignal.timeout(10_000),
  });
}

export async function setImageSize(value: string) {
  await queuedPrefWrite(() =>
    request<{ value: string }>("/prefs/image-size", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(10_000),
    })
  );
}

// View modes (strip | grid) — feed tabs and artist pages toggle
// independently; both default strip. Same prefs-DB pattern as
// image-size: GET at boot, PUT on change (queued so rapid toggles
// apply in order).
export function getFeedViewMode() {
  return request<{ value: "strip" | "grid" }>("/prefs/feed-view-mode", {
    signal: AbortSignal.timeout(10_000),
  });
}

export async function setFeedViewMode(value: string) {
  await queuedPrefWrite(() =>
    request<{ value: string }>("/prefs/feed-view-mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(10_000),
    })
  );
}

export function getArtistViewMode() {
  return request<{ value: "strip" | "grid" }>("/prefs/artist-view-mode", {
    signal: AbortSignal.timeout(10_000),
  });
}

export async function setArtistViewMode(value: string) {
  await queuedPrefWrite(() =>
    request<{ value: string }>("/prefs/artist-view-mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
      signal: AbortSignal.timeout(10_000),
    })
  );
}
