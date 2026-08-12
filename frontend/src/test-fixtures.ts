import type { PixivIllust, FeedResponse } from "./types";

let seq = 0;

export function makeIllust(overrides: Partial<PixivIllust> = {}): PixivIllust {
  seq++;
  const id = overrides.id ?? seq;
  return {
    id,
    title: overrides.title ?? `Illust ${id}`,
    type: "illust",
    caption: "",
    user: {
      id: 100 + id,
      name: overrides.user?.name ?? `Artist ${id}`,
      account: overrides.user?.account ?? `artist${id}`,
      profile_image_urls: { medium: `https://i.pximg.net/p${id}.jpg` },
    },
    image_urls: {
      square_medium: `https://i.pximg.net/s${id}.jpg`,
      medium: `https://i.pximg.net/m${id}.jpg`,
      large: `https://i.pximg.net/l${id}.jpg`,
    },
    page_count: 1,
    total_bookmarks: 100,
    total_view: 1000,
    is_bookmarked: false,
    create_date: "2026-08-01T00:00:00+00:00",
    ...overrides,
  };
}

export function makeMultiPageIllust(
  id: number,
  pageCount: number
): PixivIllust {
  return makeIllust({
    id,
    page_count: pageCount,
    meta_pages: Array.from({ length: pageCount }, (_, i) => ({
      image_urls: {
        square_medium: `https://i.pximg.net/s${id}_p${i}.jpg`,
        medium: `https://i.pximg.net/m${id}_p${i}.jpg`,
        large: `https://i.pximg.net/l${id}_p${i}.jpg`,
        original: `https://i.pximg.net/o${id}_p${i}.jpg`,
      },
    })),
  });
}

export function makeFeed(
  illusts: PixivIllust[],
  nextUrl: string | null = null
): FeedResponse {
  return { illusts, next_url: nextUrl };
}

export function makeFeedOf(
  count: number,
  startId = 1,
  nextUrl: string | null = null
): FeedResponse {
  return makeFeed(
    Array.from({ length: count }, (_, i) => makeIllust({ id: startId + i })),
    nextUrl
  );
}
