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
