export interface PixivIllust {
  id: number;
  title: string;
  type: "illust" | "manga" | "ugoira";
  caption: string;
  user: {
    id: number;
    name: string;
    account: string;
    profile_image_urls: { medium: string };
  };
  image_urls: {
    square_medium?: string;
    medium?: string;
    large: string;
  };
  page_count: number;
  meta_pages?: {
    image_urls: {
      square_medium?: string;
      medium?: string;
      large: string;
    };
  }[];
  total_bookmarks: number;
  total_view: number;
  is_bookmarked: boolean;
  create_date: string;
  tags?: { name: string; translated_name?: string }[];
}

export interface FeedResponse {
  illusts: PixivIllust[];
  next_url: string | null;
}

export interface SearchArtworksResponse {
  illusts: PixivIllust[];
  total: number;
  last_page: number;
  page: number;
  next_url: string | null;
  popular: PixivIllust[];
  related_tags: { name: string; translated_name?: string }[];
}

export interface SearchUserResult {
  id: number;
  name: string;
  avatar: string;
  premium: boolean;
  is_followed: boolean;
  previews: PixivIllust[];
}

export interface SearchUsersResponse {
  users: SearchUserResult[];
  total: number;
  page: number;
  next_url: string | null;
}

/** Content filter shared by the Ranking/Newest/Top feed pills. */
export type ContentMode = "all" | "r18";

/**
 * App-API ranking modes (GET /v1/illust/ranking?mode=...). Single
 * source of truth: RankingSelector's pill lists and the snapshot
 * restore boundary type-check against it.
 */
export const RANKING_MODES = [
  "day",
  "week",
  "month",
  "week_rookie",
  "week_original",
  "day_ai",
  "day_male",
  "day_female",
  "day_r18",
  "week_r18",
  "day_male_r18",
  "day_female_r18",
] as const;

export type RankingMode = (typeof RANKING_MODES)[number];

/** Snapshot-restore boundary: true only for real ranking modes. */
export function isRankingMode(v: string): v is RankingMode {
  return (RANKING_MODES as readonly string[]).includes(v);
}
