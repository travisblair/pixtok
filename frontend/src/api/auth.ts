import { request } from "./client";

// Login capture health: both auth surfaces probed server-side.
export function getAuthStatus() {
  return request<{ app_api: boolean; web_session: boolean }>("/auth/status", {
    signal: AbortSignal.timeout(15_000),
  });
}

// App-owned password gate (the Funnel is public).
export function gateStatus() {
  return request<{ locked: boolean }>("/gate/status", {
    signal: AbortSignal.timeout(10_000),
  });
}

export async function gateUnlock(password: string) {
  await request<{ ok: boolean }>("/gate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(15_000),
  });
}
