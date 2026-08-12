// ── Pixtok mock data factories ──────────────────────────────────────────
// Mirrors frontend/src/types.ts exactly:
//   PixivIllust { id, title, type, caption, user{...}, image_urls{...},
//     page_count, meta_pages?, total_bookmarks, total_view, is_bookmarked,
//     create_date }
//   FeedResponse { illusts, next_url }
//
// Same shape as src/test-fixtures.ts (unit tests) but self-contained JS
// so the e2e layer never depends on TS compilation. Titles/artists are
// realistic Japanese-ish so specs can distinguish batches by text.

const TITLES = [
  "星空の下で",
  "夏祭りの夜",
  "雨上がりの街角",
  "猫と読書の午後",
  "桜舞う教室",
  "冬の電車窓際",
  "海辺のピクニック",
  "ネオン街の待ち合わせ",
  "秋風とセーター",
  "月明かりの庭",
  "黄昏の屋上",
  "雪化粧の神社",
];

const ARTISTS = [
  "蒼井そらまめ",
  "月島まる",
  "ふゆのあかり",
  "七瀬くろ",
  "花咲みお",
  "藤堂りん",
];

const ACCOUNTS = [
  "aoi_soramame",
  "tsukishima_maru",
  "fuyu_no_akari",
  "nanase_kuro",
  "hanasaki_mio",
  "toudou_rin",
];

let seq = 0;

/**
 * Build a single PixivIllust. All fields typed per src/types.ts.
 * Ids are emitted as STRINGS — matching what the Go backend's web-AJAX
 * transforms actually put on the wire (the FE api layer normalizes them
 * back to numbers, which the e2e assertions rely on).
 */
export function makeIllust(overrides = {}) {
  seq++;
  const idNum = Number(overrides.id ?? seq);
  const id = String(idNum);
  const t = TITLES[idNum % TITLES.length];
  const a = ARTISTS[idNum % ARTISTS.length];
  return {
    id,
    title: overrides.title ?? `${t} ${idNum}`,
    type: "illust",
    caption: `オリジナル作品 ${idNum}。よろしくお願いします。`,
    user: {
      id: String(1000 + idNum),
      name: overrides.user?.name ?? a,
      account: overrides.user?.account ?? `${ACCOUNTS[idNum % ACCOUNTS.length]}_${idNum}`,
      profile_image_urls: {
        medium: `https://i.pximg.net/user-profile/img/${idNum}_50x50.jpg`,
      },
    },
    image_urls: {
      square_medium: `https://i.pximg.net/c/360x360_70/img-master/${idNum}_square1200.jpg`,
      medium: `https://i.pximg.net/c/540x540_70/img-master/${idNum}_master1200.jpg`,
      large: `https://i.pximg.net/img-original/img/${idNum}_p0.jpg`,
    },
    page_count: 1,
    total_bookmarks: 100 + (idNum % 900),
    total_view: 1000 + idNum * 37,
    is_bookmarked: false,
    create_date: "2026-08-01T00:00:00+00:00",
    ...overrides,
  };
}

/**
 * Multi-page (manga/ugoira-style) illust: page_count pages with distinct
 * meta_pages image URLs, matching the src/types.ts optional shape.
 */
export function makeMultiPageIllust(id, pageCount) {
  const sid = String(id);
  return makeIllust({
    id: sid,
    page_count: pageCount,
    type: "manga",
    meta_pages: Array.from({ length: pageCount }, (_, i) => ({
      image_urls: {
        square_medium: `https://i.pximg.net/c/360x360_70/img-master/${sid}_p${i}_square1200.jpg`,
        medium: `https://i.pximg.net/c/540x540_70/img-master/${sid}_p${i}_master1200.jpg`,
        large: `https://i.pximg.net/img-original/img/${sid}_p${i}.jpg`,
      },
    })),
  });
}

/** Wrap an illust array in a FeedResponse. */
export function makeFeed(illusts, nextUrl = null) {
  return { illusts, next_url: nextUrl };
}

/**
 * A batch of `count` single-page illusts with sequential ids starting at
 * startId, plus the given next_url (FeedResponse shape).
 */
export function makeFeedOf(count, startId = 1, nextUrl = null) {
  return makeFeed(
    Array.from({ length: count }, (_, i) =>
      makeIllust({ id: String(startId + i) })
    ),
    nextUrl
  );
}

/** 1x1 transparent PNG used by the /api/img mock. */
export const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** The 1px GIF data URI FeedCard swaps in for unloaded images. */
export const PIXEL_DATA_URI =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
