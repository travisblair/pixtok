import { request } from "./client";
import type { FeedResponse } from "../types";

// Follow (live-verified app-API endpoints). restrict is fixed public
// server-side — following is a public action on pixiv.
export function follow(userId: number) {
  return request<{ ok: boolean }>(`/user/${userId}/follow`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
}

export function unfollow(userId: number) {
  return request<{ ok: boolean }>(`/user/${userId}/unfollow`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
}

export function getFollowed(userId: number) {
  // followed is null while the backend's 429 circuit breaker is
  // cooling: "unknown" is not an error — the button just stays hidden.
  return request<{ followed: boolean | null }>(`/user/${userId}/followed`, {
    signal: AbortSignal.timeout(15_000),
  });
}

// Artist's works (app API, paginated).
export function getUserIllusts(userId: number) {
  return request<FeedResponse>(
    `/user/${userId}/illusts`,
    { signal: AbortSignal.timeout(15_000) }
  );
}
