import { request } from "./client";
import type { FeedResponse } from "../types";

// Like/unlike are POSTs with a JSON {ok:true} body — route them
// through the shared request helper (same error shape and timeout
// discipline as every other call).
export function like(illustId: number) {
  return request<{ ok: boolean }>(`/illust/${illustId}/like`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
}

export function unlike(illustId: number) {
  return request<{ ok: boolean }>(`/illust/${illustId}/unlike`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
}

// Tap-stack related works (v2/illust/related — app-API similarity
// engine, paginated). Distinct from getWorkRecs (recommend/init, the
// site's per-work section used by the like-modal).
export function getRelated(illustId: number) {
  return request<FeedResponse>(
    `/illust/${illustId}/related`,
    { signal: AbortSignal.timeout(15_000) }
  );
}

// Per-work recommendations (recommend/init — the same "Related works"
// section the pixiv.net artwork page shows). DISTINCT from getRelated:
// the tap-stack uses the app-API similarity engine (paginated), while
// the like-modal uses this site engine (finite ~18). Both are per-work;
// they're just two different recommendation systems.
export function getWorkRecs(illustId: number, signal?: AbortSignal) {
  return request<FeedResponse>(
    `/illust/${illustId}/recs`,
    { signal: signal ?? AbortSignal.timeout(15_000) }
  );
}
