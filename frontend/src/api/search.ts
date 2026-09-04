import { request } from "./client";
import type { SearchArtworksResponse, SearchUsersResponse } from "../types";

// Search — the site's search pages. Works search carries the tag's
// popular block (the search-page recommendations) + related tags.
// Filter params are the verified set (live-probed Aug 2026): order,
// mode, work type (endpoint switch), s_mode, ai_type, scd/sce.
export function searchArtworks(params: {
  word: string;
  order?: string;
  contentMode?: "all" | "safe" | "r18";
  workType?: "all" | "illust" | "ugoira";
  sMode?: string;
  aiType?: "0" | "1";
  scd?: string;
  sce?: string;
  p?: number;
}) {
  const q = new URLSearchParams({
    word: params.word,
    order: params.order ?? "date_d",
    mode: params.contentMode ?? "all",
    // s_tag_full: matches this account's saved search defaults (the
    // site's FRESH default is partial match — s_tag — per the Aug
    // 2026 modal crawl; pixtok keeps exact as the default).
    s_mode: params.sMode ?? "s_tag_full",
    type: params.workType ?? "all",
    ai_type: params.aiType ?? "0",
  });
  if (params.scd) q.set("scd", params.scd);
  if (params.sce) q.set("sce", params.sce);
  if (params.p) q.set("p", String(params.p));
  return request<SearchArtworksResponse>(
    `/search/artworks?${q}`,
    { signal: AbortSignal.timeout(15_000) }
  );
}

export function searchUsers(nick: string, p: number) {
  const q = new URLSearchParams({ nick, s_mode: "s_usr", p: String(p) });
  return request<SearchUsersResponse>(
    `/search/users?${q}`,
    { signal: AbortSignal.timeout(15_000) }
  );
}

// Ugoira animation metadata (web AJAX passthrough).
export function getUgoiraMeta(illustId: number) {
  return request<{
    error: boolean;
    body: {
      src: string;
      originalSrc: string;
      mime_type: string;
      frames: { file: string; delay: number }[];
    };
  }>(`/illust/${illustId}/ugoira_meta`, {
    // 60s, not 15: the meta hop rides the Pi relay and iOS-tailscale
    // stalls are a real failure mode on the phone (the server journal
    // showed an /api/img request dying at exactly 15.002s — a client
    // abort at its old 15s deadline). The zip already allows 120s;
    // meta and poster should not give up 8x sooner.
    signal: AbortSignal.timeout(60_000),
  });
}
