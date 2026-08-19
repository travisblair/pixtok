import { createSignal, createEffect, createMemo, For, Show, onCleanup, onMount } from "solid-js";
import { api, setOnGateLocked } from "./api";
import type { PixivIllust } from "./types";
import { dedupeSeen, filterBlockedTags } from "./helpers";
import {
  blockedTags,
  seedLikedIds,
  setBlockedTagsList,
  setImageSizeFromServer,
  feedViewMode,
  setFeedViewModeFromServer,
  setArtistViewModeFromServer,
} from "./store";
import FeedCard from "./components/FeedCard";
import GridFeed from "./components/GridFeed";
import RankingSelector from "./components/RankingSelector";
import ContentPills from "./components/ContentPills";
import NavigationDrawer from "./components/NavigationDrawer";
import RecsModal from "./components/RecsModal";
import RelatedView from "./components/RelatedView";
import ArtistView from "./components/ArtistView";
import SearchScreen from "./components/SearchScreen";
import type { SearchState } from "./components/SearchScreen";
import { DEFAULT_FILTERS } from "./components/SearchFilters";
import GateScreen from "./components/GateScreen";
import ConfigModal from "./components/ConfigModal";
import TagPopup from "./components/TagPopup";
import LoginScreen from "./components/LoginScreen";
import {
  loadSnapshot,
  saveSnapshot,
  MAX_STACK_DEPTH,
} from "./state-persistence";
import { useFeedSentinel, useToast } from "./hooks";
import "./App.css";

type FeedType = "home" | "newest" | "illustrations" | "top" | "recommended" | "bookmarks";

// Overlay slide-out animation duration. The CSS keyframes
// (slide-out-rtl/ltr in App.css) are 250ms; the JS close timeouts wait
// 260ms so the DOM removal never cuts the animation short. If you
// change the CSS duration, change this too.
const SLIDE_OUT_MS = 250;
const CLOSE_TIMEOUT_MS = SLIDE_OUT_MS + 10;

// Base z-index the overlay counter starts from. Must stay BELOW the
// modal (z-100) and toast (z-110) strata in App.css — the counter is
// reset whenever every overlay closes so a long session can never
// climb past them.
const LAYER_Z_BASE = 40;

export default function App() {
  const [feedType, setFeedType] = createSignal<FeedType>("home");
  // Ranking tab: content row (all | r18) + mode row (day/week/...).
  const [rankContent, setRankContent] = createSignal("all");
  const [rankMode, setRankMode] = createSignal("day");
  // Newest tab: all | r18 content filter.
  const [newestR18, setNewestR18] = createSignal(false);
  // Bookmarks tab: tag pills from the bookmarks page (public list) +
  // the active tag filter ("" = all bookmarks).
  const [bookmarkTags, setBookmarkTags] = createSignal<
    { name: string; count: number }[]
  >([]);
  const [bookmarkTag, setBookmarkTag] = createSignal("");
  // Illustrations (top page) tab: all | r18.
  const [topMode, setTopMode] = createSignal("all");
  const [illusts, setIllusts] = createSignal<PixivIllust[]>([]);
  const [nextUrl, setNextUrl] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [recs, setRecs] = createSignal<PixivIllust[]>([]);
  const [recsSource, setRecsSource] = createSignal("");
  const [modalOpen, setModalOpen] = createSignal(false);
  const toast = useToast();
  const [loadError, setLoadError] = createSignal(false);
  const [configOpen, setConfigOpen] = createSignal(false);
  const [loginOpen, setLoginOpen] = createSignal(false);
  const [tagsIllust, setTagsIllust] = createSignal<PixivIllust | null>(null);
  // When the search layer is ALREADY open, tag taps re-seed it through
  // this signal (SearchScreen re-runs on change instead of remounting).
  const [searchSeed, setSearchSeed] = createSignal<string | null>(null);
  const [artist, setArtist] = createSignal<{ id: number; name: string; z: number } | null>(null);
  const [artistClosing, setArtistClosing] = createSignal(false);
  // Search layer (opened from the drawer — own feed, own state).
  const [searchLayer, setSearchLayer] = createSignal<{ z: number } | null>(null);
  const [searchClosing, setSearchClosing] = createSignal(false);
  const [searchState, setSearchState] = createSignal<SearchState | null>(null);
  // 1-based depth of the stack level currently animating out; null = none.
  const [closingDepth, setClosingDepth] = createSignal<number | null>(null);
  const [stack, setStack] = createSignal<{ illust: PixivIllust; z: number }[]>([]);
  let sentinelRef: HTMLDivElement | undefined;
  let feedContainerRef: HTMLDivElement | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let reqSeq = 0; // request epoch — invalidated on feed/mode switch
  // Monotonic layer counter: every overlay (stack level OR artist page)
  // takes the next z-index, so whatever opens LAST is always on top —
  // an artist page tapped from inside a stack must cover that stack.
  let layerZ = LAYER_Z_BASE;
  // Open-order of overlay layers ("search", "s0".."sN" stack levels,
  // "artist") — persisted so a reload restores the SAME stacking order
  // instead of guessing (the old restore always put the artist on top,
  // flipping artist-under-stack sessions).
  const [layerSeq, setLayerSeq] = createSignal<string[]>([]);
  // z-index of the topmost overlay (0 = nothing above the main feed).
  // DERIVED, never assigned: the single source of truth is the open
  // order plus each layer's state. Every close path used to recompute
  // this independently, and open-during-close races left it pointing at
  // a layer that wasn't visually on top — the visible layer then marked
  // itself obscured and unloaded every image (the black-screen class).
  // Closing layers are skipped: they're already on the way out, so the
  // layer beneath takes over immediately.
  const topZ = createMemo(() => {
    let z = 0;
    for (const key of layerSeq()) {
      if (key === "artist") {
        const a = artist();
        if (a && !artistClosing()) z = a.z;
      } else if (key === "search") {
        const sl = searchLayer();
        if (sl && !searchClosing()) z = sl.z;
      } else if (key.startsWith("s")) {
        const i = Number(key.slice(1));
        const entry = stack()[i];
        if (entry && closingDepth() !== i + 1) z = entry.z;
      }
    }
    return z;
  });

  // Dev invariant: a rendered, non-closing layer must never sit above
  // topZ — that would suppress the visible layer's images. Log loudly
  // so dogfood sessions catch any future desync before it ships.
  if (import.meta.env.DEV) {
    createEffect(() => {
      const tz = topZ();
      const offenders: string[] = [];
      const a = artist();
      if (a && !artistClosing() && a.z > tz) offenders.push(`artist(z=${a.z})`);
      const sl = searchLayer();
      if (sl && !searchClosing() && sl.z > tz) offenders.push(`search(z=${sl.z})`);
      stack().forEach((entry, i) => {
        if (closingDepth() !== i + 1 && entry.z > tz) {
          offenders.push(`s${i}(z=${entry.z})`);
        }
      });
      if (offenders.length > 0) {
        console.warn(
          `[z-index] layer(s) above topZ=${tz}: ${offenders.join(", ")} — images suppressed`
        );
      }
    });
  }
  // Pixiv's personalized feeds re-inject works across pages (the street
  // cursor explicitly carries overlap) — dedupe by id on append.
  const seenIds = new Set<number>();

  // fresh forces a first-page load regardless of nextUrl. Switch paths
  // pass fresh=true because the load is sequenced directly after the
  // resets — never through reactive-effect timing, which can read stale
  // signal values (the source of the "Nothing here yet" switch bug).
  async function loadMore(fresh = false) {
    if (loading()) return;
    const seq = ++reqSeq;
    setLoading(true);
    try {
      let data;
      if (feedType() === "home") {
        // Street: next_url carries the nextParams cursor JSON verbatim.
        data = await api.getStreet(fresh ? "" : (nextUrl() ?? ""));
      } else if (feedType() === "newest") {
        // Newest firehose: next_url is a relative /api/newest cursor URL.
        data =
          !fresh && nextUrl()
            ? await api.getNewestNext(nextUrl()!)
            : await api.getNewest(newestR18());
      } else if (feedType() === "illustrations") {
        // App-API ranking: paginated via next_url like other app feeds.
        data =
          !fresh && nextUrl()
            ? await api.getNextPage(nextUrl()!)
            : await api.getTop(rankMode());
      } else if (feedType() === "top") {
        // /illustration top page: fixed grid, no pagination.
        data = await api.getTopIllust(topMode());
      } else if (feedType() === "bookmarks") {
        // Bookmarks PAGE (web AJAX, crawl-verified): tag-filtered with
        // blind offset pagination. next_url is self-referential
        // /api/bookmarks and must NOT ride /api/next (SSRF allowlist).
        data =
          !fresh && nextUrl()
            ? await api.getBookmarksNext(nextUrl()!)
            : await api.getBookmarks(bookmarkTag());
      } else if (nextUrl() && !fresh) {
        data = await api.getNextPage(nextUrl()!);
      } else {
        data = await api.getRecommended();
      }

      // Feed or mode changed while this request was in flight — discard.
      if (seq !== reqSeq) return;

      // Pixiv's personalized feeds overlap across pages — dedupe before
      // appending so re-injected works don't show up twice, then drop
      // anything carrying a blocked tag.
      const newItems = dedupeSeen(
        seenIds,
        filterBlockedTags(data.illusts, blockedTags())
      );

      setIllusts(prev => [...prev, ...newItems]);
      setNextUrl(data.next_url);
      setLoadError(false);
    } catch (err) {
      if (seq === reqSeq) {
        console.error("Failed to load feed:", err);
        // Surface the failure at the sentinel — the observer won't
        // re-fire on its own (nextUrl unchanged, no geometry change),
        // so without this the feed would silently dead-end.
        setLoadError(true);
      }
    } finally {
      if (seq === reqSeq) setLoading(false);
    }
  }

  function changeFeedType(type: FeedType) {
    if (type === feedType()) return;
    reqSeq++; // invalidate any in-flight load
    setFeedType(type);
    setIllusts([]);
    setNextUrl(null);
    setLoading(false);
    setLoadError(false); // fresh feed has no load error
    seenIds.clear();
    void loadMore(true); // fresh first page, sequenced AFTER the resets
  }

  // Bookmarks tab: switching the tag filter reloads the page from zero.
  function selectBookmarkTag(tag: string) {
    if (tag === bookmarkTag()) return;
    reqSeq++; // invalidate any in-flight load
    setBookmarkTag(tag);
    resetFeedAndReload();
  }

  // The bookmarks tab IS the bookmark page: unbookmarking removes the
  // work from the feed (no other tab filters its list on unlike).
  function handleUnlike(illust: PixivIllust) {
    if (feedType() === "bookmarks") {
      setIllusts((prev) => prev.filter((x) => x.id !== illust.id));
    }
  }

  function resetFeedAndReload() {
    setIllusts([]);
    setNextUrl(null);
    setLoading(false);
    setLoadError(false); // fresh feed has no load error
    seenIds.clear();
    void loadMore(true); // fresh first page, sequenced AFTER the resets
  }

  function changeRankingContent(c: string) {
    if (c === rankContent()) return;
    reqSeq++; // invalidate any in-flight load
    setRankContent(c);
    // The current mode may not exist in the new content's set — fall
    // back to the default for that row (rookie/original/AI have no
    // R-18 counterpart).
    setRankMode(c === "r18" ? "day_r18" : "day");
    resetFeedAndReload();
  }

  function changeRankingMode(m: string) {
    if (m === rankMode()) return;
    reqSeq++;
    setRankMode(m);
    resetFeedAndReload();
  }

  function changeNewestR18(c: string) {
    const v = c === "r18";
    if (v === newestR18()) return;
    reqSeq++;
    setNewestR18(v);
    resetFeedAndReload();
  }

  function changeTopMode(m: string) {
    if (m === topMode()) return;
    reqSeq++;
    setTopMode(m);
    resetFeedAndReload();
  }

  const showToast = toast.show;

  function openRecs() {
    if (!toast.opens()) return; // error toasts don't open the modal
    toast.hide();
    setModalOpen(true);
  }

  // Push a related view for the tapped image. Refuses to re-open a work
  // that's already somewhere in the stack (endless self-drilling).
  function pushRelated(illust: PixivIllust) {
    if (closingDepth() !== null) return; // mid pop-animation — ignore taps
    if (stack().some((a) => a.illust.id === illust.id)) {
      showToast("This work is already open — tap Back to return to it", false);
      return;
    }
    if (stack().length >= MAX_STACK_DEPTH) {
      showToast(`Max stack depth reached (${MAX_STACK_DEPTH}) — go back to open more`, false);
      return;
    }
    toast.hide(); // don't let the toast sit hidden under the stack
    layerZ++;
    setLayerSeq([...layerSeq(), `s${stack().length}`]);
    setStack(prev => [...prev, { illust, z: layerZ }]);
  }

  function popRelated() {
    if (closingDepth() !== null) return; // already animating out
    const depth = stack().length;
    if (depth === 0) return;
    setClosingDepth(depth); // play the slide-out on the top view
    // Flush the close to the snapshot before the animation — a kill
    // during the slide-out must not resurrect this level.
    setLayerSeq(layerSeq().filter((k) => k !== `s${depth - 1}`));
    persistNow({ stack: stack().slice(0, -1).map((s) => s.illust) });
    setTimeout(() => {
      setStack(prev => prev.slice(0, -1));
      setClosingDepth(null);
    }, CLOSE_TIMEOUT_MS);
  }

  // When the last overlay closes, rewind the layer counter — it is
  // monotonic while overlays are open (so whatever opens last stacks on
  // top), but without a reset a long session would eventually push new
  // overlay z-indexes ABOVE the modal/toast strata and bury popups
  // underneath the feed layers.
  function resetLayerZIfIdle() {
    if (
      stack().length === 0 &&
      !artist() &&
      !searchLayer() &&
      closingDepth() === null &&
      !artistClosing() &&
      !searchClosing()
    ) {
      layerZ = LAYER_Z_BASE;
    }
  }

  function closeAllStacks() {
    // Stacks and the modal close; an artist page (or search layer)
    // beneath stays open and keeps its place in the open order. The
    // old code silently persisted artist:null here — a reload dropped
    // the layer you had just landed back on.
    setLayerSeq(layerSeq().filter((k) => !k.startsWith("s")));
    persistNow({ stack: [], modalOpen: false });
    setStack([]);
    setModalOpen(false);
    resetLayerZIfIdle();
  }

  function openArtist(illust: PixivIllust) {
    layerZ++;
    setArtist({ id: illust.user.id, name: illust.user.name || illust.user.account, z: layerZ });
    setLayerSeq([...layerSeq(), "artist"]);
  }

  // Search's artist rows carry a bare user identity (no illust object) —
  // same artist overlay, different entry shape.
  function openArtistUser(user: { id: number; name: string }) {
    layerZ++;
    setArtist({ id: user.id, name: user.name, z: layerZ });
    setLayerSeq([...layerSeq(), "artist"]);
  }

  function closeArtist() {
    if (artistClosing()) return;
    setArtistClosing(true); // play the slide-out
    // The close MUST hit the snapshot immediately: the page can be
    // jetsam-killed during the 250ms slide-out, and the debounced save
    // would miss it — the next reload resurrects the artist page with
    // no way out (reload → restore → reload loop until iOS kills the
    // tab). Same flush on every close action below.
    const closingZ = artist()?.z;
    setLayerSeq(layerSeq().filter((k) => k !== "artist"));
    persistNow({ artist: null });
    setTimeout(() => {
      // Idempotent: if a NEW artist opened mid-animation (different z),
      // this stale timer must not clear it.
      setArtist(a => (closingZ !== undefined && a && a.z === closingZ ? null : a));
      setArtistClosing(false);
      resetLayerZIfIdle();
    }, CLOSE_TIMEOUT_MS);
  }

  function openSearch() {
    if (searchLayer()) return;
    layerZ++;
    setSearchLayer({ z: layerZ });
    setLayerSeq([...layerSeq(), "search"]);
  }

  /** Fresh search-layer state seeded with a tag (the tag's works page). */
  function makeInitialSearchState(tag: string): SearchState {
    return {
      word: tag,
      mode: "works",
      order: DEFAULT_FILTERS.order,
      contentMode: DEFAULT_FILTERS.contentMode,
      workType: DEFAULT_FILTERS.workType,
      sMode: DEFAULT_FILTERS.sMode,
      aiType: DEFAULT_FILTERS.aiType,
      dateMode: DEFAULT_FILTERS.dateMode,
      scd: "",
      sce: "",
      works: [],
      popular: [],
      related: [],
      users: [],
      page: 0,
      hasMore: false,
    };
  }

  /** Tap a tag anywhere → its works page (pixiv's tag page). */
  function openTagPage(tag: string) {
    setTagsIllust(null);
    if (searchLayer()) {
      // Re-seed the existing layer in place (SearchScreen listens on
      // seedTag and re-runs — same as tapping a related-tag pill).
      setSearchSeed(tag);
    } else {
      setSearchState(makeInitialSearchState(tag));
      openSearch();
    }
  }

  function closeSearch() {
    if (searchClosing()) return;
    setSearchClosing(true); // play the slide-out
    const closingZ = searchLayer()?.z;
    setLayerSeq(layerSeq().filter((k) => k !== "search"));
    persistNow({ searchOpen: false, search: null });
    setTimeout(() => {
      setSearchLayer(sl => (closingZ !== undefined && sl && sl.z === closingZ ? null : sl));
      setSearchClosing(false);
      resetLayerZIfIdle();
    }, CLOSE_TIMEOUT_MS);
  }

  // Aborts the previous like's recs fetch so a fast tap-tap-tap can't
  // resolve out of order (last-arriving must not win over last-tapped).
  let recsAbort: AbortController | undefined;

  async function handleLike(illust: PixivIllust) {
    recsAbort?.abort();
    recsAbort = new AbortController();
    const signal = recsAbort.signal;
    try {
      // Per-work recommendations via recommend/init — the same "Related
      // works" section the site shows on this work's page. Intentionally
      // DISTINCT from the tap-stack's v2/related similarity engine.
      const data = await api.getWorkRecs(illust.id, signal);
      if (data.illusts.length === 0) return;
      // Replace semantics: each like loads a fresh recs batch for the modal.
      setRecs(filterBlockedTags(data.illusts, blockedTags()));
      setRecsSource(illust.title);
      // Full title — the toast wraps (full-width bar), no truncation.
      showToast(`Recommendations for "${illust.title}"`);
    } catch (err) {
      // AbortError = superseded by a newer like — not a failure.
      if (!signal.aborted) {
        console.error("Failed to load work recommendations:", err);
        showToast("Couldn't load recommendations", false);
      }
    }
  }

  // Load the first page on mount — UNLESS a saved snapshot rehydrates
  // the session (iOS jetsam reloads land the user back where they were:
  // same feed, same pills, same scroll, stacks + recs modal restored).
  // Feed/mode switches trigger their own loads directly inside
  // changeFeedType/changeRanking* (sequenced after the state resets) —
  // never via an effect, whose timing can read stale signal values.
  const [feedScrollTop, setFeedScrollTop] = createSignal(0);
  // Password gate: locked until the backend confirms otherwise.
  const [gateLocked, setGateLocked] = createSignal(true);
  let booted = false;

  // boot runs everything the app needs at startup — seeds, snapshot
  // rehydrate, first feed page — but only once the gate is open (API
  // calls 403 while locked).
  function boot() {
    if (booted) return;
    booted = true;

    // Server truth seeds (fire-and-forget, reactive): hearts from
    // pixiv's bookmarks endpoint, blocked tags from the prefs DB.
    // Both update already-mounted cards when they land.
    void api
      .getBookmarkIds()
      .then((d) => seedLikedIds(d.ids))
      .catch(() => {});
    void api
      .getBlockedTags()
      .then((d) => setBlockedTagsList(d.tags))
      .catch(() => {});
    void api
      .getImageSize()
      .then((d) => setImageSizeFromServer(d.value))
      .catch(() => {});
    // View modes are global prefs (server DB), not session state — they
    // seed like blocked tags and never touch the snapshot.
    void api
      .getFeedViewMode()
      .then((d) => setFeedViewModeFromServer(d.value))
      .catch(() => {});
    void api
      .getArtistViewMode()
      .then((d) => setArtistViewModeFromServer(d.value))
      .catch(() => {});
    // Bookmark tags feed the bookmarks-tab pills (public list only —
    // the page's default view).
    void api
      .getBookmarkTags()
      .then((d) => setBookmarkTags(d.public))
      .catch(() => {});

    const snap = loadSnapshot();
    if (snap) {
      reqSeq++; // anything an effect triggers during rehydrate gets discarded
      // Self-heal: a snapshot saved while the gate was locked (or mid-
      // churn) can carry an empty feed with no cursor — restoring it
      // verbatim strands the app on "Nothing here yet". Treat an empty,
      // cursorless snapshot as no snapshot: load fresh instead.
      const healable =
        snap.illusts.length === 0 &&
        !snap.nextUrl &&
        !snap.searchOpen &&
        snap.stack.length === 0 &&
        !snap.artist &&
        !snap.modalOpen;
      if (healable) {
        void loadMore(true);
        return;
      }
      setFeedType(snap.feedType as FeedType);
      setRankContent(snap.rankContent === "r18" ? "r18" : "all");
      setRankMode(snap.rankMode);
      setNewestR18(!!snap.newestR18);
      setTopMode(snap.topMode === "r18" ? "r18" : "all");
      setIllusts(snap.illusts);
      setNextUrl(snap.nextUrl);
      for (const ill of snap.illusts) seenIds.add(ill.id);

      // Restore overlay z-values in the SAVED open order — the stacking
      // must match the live session exactly. The old restore always put
      // the artist on top: an artist-under-stack session came back
      // flipped, and wrong obscured flags suppressed the top layer's
      // images (the recurring black-screen class).
      let restoredSearchZ = 0;
      let restoredArtistZ = 0;
      const restoredZs: number[] = new Array(snap.stack.length).fill(0);
      const order =
        snap.layerOrder.length > 0
          ? snap.layerOrder
          : ["search", ...snap.stack.map((_, i) => `s${i}`), "artist"];
      for (const key of order) {
        if (key === "search" && snap.searchOpen && snap.search) {
          layerZ++;
          restoredSearchZ = layerZ;
        } else if (key === "artist" && snap.artist) {
          layerZ++;
          restoredArtistZ = layerZ;
        } else if (key.startsWith("s")) {
          const i = Number(key.slice(1));
          if (Number.isInteger(i) && i >= 0 && i < snap.stack.length) {
            layerZ++;
            restoredZs[i] = layerZ;
          }
        }
      }
      // Any layer missing from the saved order still gets a z (appended
      // on top — matches "opened later" semantics).
      if (snap.searchOpen && snap.search && restoredSearchZ === 0) {
        layerZ++;
        restoredSearchZ = layerZ;
      }
      for (let i = 0; i < snap.stack.length; i++) {
        if (restoredZs[i] === 0) {
          layerZ++;
          restoredZs[i] = layerZ;
        }
      }
      if (snap.artist && restoredArtistZ === 0) {
        layerZ++;
        restoredArtistZ = layerZ;
      }

      if (snap.searchOpen && snap.search) {
        setSearchState(snap.search);
        setSearchLayer({ z: restoredSearchZ });
      }
      setStack(snap.stack.map((ill, i) => ({ illust: ill, z: restoredZs[i] })));
      if (snap.artist) {
        setArtist({ id: snap.artist.id, name: snap.artist.name, z: restoredArtistZ });
      }
      setLayerSeq(
        order.filter((k) => {
          if (k === "search") return snap.searchOpen && !!snap.search;
          if (k === "artist") return !!snap.artist;
          const i = Number(k.slice(1));
          return Number.isInteger(i) && i >= 0 && i < snap.stack.length;
        })
      );

      // topZ is DERIVED from the restored open order + layer state —
      // no assignment here (see the topZ memo). The modal's obscured
      // flag (topZ() > 0) must still read 0 when nothing was restored
      // above it.

      if (snap.modalOpen && snap.recs.length > 0) {
        setRecs(snap.recs);
        setRecsSource(snap.recsSource);
        setModalOpen(true);
        // NOTE: do NOT touch topZ here. The modal's `obscured` flag is
        // computed as topZ() > 0 ("a stack/artist sits ABOVE me"), so a
        // restored modal with nothing above it must see topZ = 0 — bumping
        // it to the modal's z made the modal suppress ITS OWN images
        // (every reload rehydrated modalOpen=true → permanent black
        // cards, unfixable by reloading).
      }

      // Cards are exactly 100dvh tall, so restoring scrollTop lands on
      // the same card index regardless of image load state.
      const target = snap.scrollTop;
      if (target > 0) {
        requestAnimationFrame(() => {
          if (feedContainerRef) feedContainerRef.scrollTop = target;
        });
      }
      return;
    }
    void loadMore(true);
  }

  onMount(() => {
    // Mid-session gate re-lock: any later request() that hits a 403
    // "gate locked" re-shows the GateScreen (the status check below
    // only runs once at mount). Without this the app silently degrades
    // — hidden follow buttons, dead feeds — with no path back to
    // unlocking except a manual reload.
    setOnGateLocked(() => setGateLocked(true));
    void api
      .gateStatus()
      .then((s) => {
        if (s.locked) return; // gate screen stays up; boot on unlock
        setGateLocked(false);
        boot();
      })
      .catch(() => {
        // Backend unreachable — show the gate; a reload re-checks.
        setGateLocked(true);
      });
  });

  // Debounced snapshot: any tracked state change re-writes the saved
  // session (500ms settle). Reads all signals so every change is seen;
  // the setTimeout body runs untracked, so no persistence loop.
  createEffect(() => {
    void feedType();
    void rankContent();
    void rankMode();
    void newestR18();
    void topMode();
    void illusts();
    void nextUrl();
    void feedScrollTop();
    void stack();
    void artist();
    void recs();
    void recsSource();
    void modalOpen();
    void searchLayer();
    void searchState();
    void gateLocked();
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      // Never snapshot while the gate is locked — the pre-boot state is
      // an empty feed, and saving it would strand the next unlock on
      // "Nothing here yet".
      if (gateLocked()) return;
      saveSnapshot(buildSnapshotState());
    }, 500);
  });

  /** The full current state, as the debounced saver would write it. */
  function buildSnapshotState() {
    return {
      feedType: feedType(),
      rankContent: rankContent(),
      rankMode: rankMode(),
      newestR18: newestR18(),
      topMode: topMode(),
      illusts: illusts(),
      nextUrl: nextUrl(),
      scrollTop: feedScrollTop(),
      stack: stack().map((s) => s.illust),
      artist: artist() ? { id: artist()!.id, name: artist()!.name } : null,
      recs: recs(),
      recsSource: recsSource(),
      modalOpen: modalOpen(),
      searchOpen: searchLayer() !== null,
      search: searchState(),
      layerOrder: [...layerSeq()],
    };
  }

  /**
   * Write the snapshot SYNCHRONOUSLY, overriding specific fields. Used
   * by layer-close actions: iOS can jetsam-kill the page during the
   * 250ms slide-out, long before the 500ms debounce fires — without
   * this the stale snapshot resurrects the layer on the next reload and
   * the user is trapped (reload → restore → reload until Safari gives
   * up). A close must be permanent the instant the user asks for it.
   */
  function persistNow(overrides: Partial<ReturnType<typeof buildSnapshotState>>) {
    if (gateLocked()) return;
    saveSnapshot({ ...buildSnapshotState(), ...overrides });
  }

  // IntersectionObserver on sentinel for infinite scroll
  onCleanup(() => {
    clearTimeout(persistTimer);
    setOnGateLocked(null);
  });
  useFeedSentinel(
    () => sentinelRef,
    // loadError() must gate pagination: without it, a failed page load
    // re-subscribes the observer (loading flips false) and its initial
    // callback fires immediately — an infinite 429 loop that rate-limits
    // pixiv. With the guard, a failure shows the retry button and STOPS
    // until the user taps it.
    () => !!nextUrl() && !loading() && !loadError(),
    () => void loadMore(),
    // Prefetch distance depends on the renderer. The strip's 2400px is
    // ~2.7 100dvh cards. Grid cells are ~123px: the same absolute
    // margin would sit far inside the first page (30 cells ≈ 1300px),
    // auto-firing pages on boot and chain-firing after every load.
    // ~400px ≈ 3 rows of cells: enough prefetch, and the boot-time
    // sentinel distance (~500px) stays OUTSIDE it, so nothing fires
    // until the user actually scrolls near the bottom.
    () => (feedViewMode() === "grid" ? "400px" : "2400px")
  );

  return (
    <>
      {/* Password gate — while locked, ONLY the gate exists (the app UI
          must not render underneath: its empty/error states would
          otherwise mount and unmount around boot). */}
      <Show when={gateLocked()}>
        <GateScreen
          onUnlocked={() => {
            setGateLocked(false);
            boot();
          }}
        />
      </Show>

      <Show when={!gateLocked()}>
      <div
        class={
          feedViewMode() === "grid"
            ? "feed-container grid-container"
            : "feed-container"
        }
        ref={feedContainerRef}
        onScroll={(e) =>
          setFeedScrollTop((e.currentTarget as HTMLElement).scrollTop)
        }
      >
        {/* Header area: row 1 = burger + content pills, row 2 = the
            ranking mode pills (below the burger). */}
        <div class="header-bar">
          <div class="header-row">
            <NavigationDrawer
              feedType={feedType()}
              onChange={changeFeedType}
              onSearch={openSearch}
              onSettings={() => setConfigOpen(true)}
              onLogin={() => setLoginOpen(true)}
            />
            <Show when={feedType() === "illustrations"}>
              <ContentPills
                content={rankContent()}
                onChange={changeRankingContent}
              />
            </Show>
            <Show when={feedType() === "newest"}>
              <ContentPills
                content={newestR18() ? "r18" : "all"}
                onChange={changeNewestR18}
              />
            </Show>
            <Show when={feedType() === "top"}>
              <ContentPills content={topMode()} onChange={changeTopMode} />
            </Show>
            <Show when={feedType() === "bookmarks"}>
              <div class="mode-pill-row no-scrollbar fade-edges">
                <button
                  type="button"
                  class={bookmarkTag() === "" ? "mode-pill active" : "mode-pill"}
                  onClick={() => selectBookmarkTag("")}
                >
                  All
                </button>
                <For each={bookmarkTags()}>
                  {(tag) => (
                    <button
                      type="button"
                      class={
                        bookmarkTag() === tag.name
                          ? "mode-pill active"
                          : "mode-pill"
                      }
                      onClick={() => selectBookmarkTag(tag.name)}
                    >
                      {tag.name}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <Show when={feedType() === "illustrations"}>
            <RankingSelector
              content={rankContent()}
              mode={rankMode()}
              onChange={changeRankingMode}
            />
          </Show>
        </div>

        <Show
          when={illusts().length > 0 || loading()}
          fallback={
            <div class="empty-feed">
              <span>Nothing here yet</span>
              <button
                type="button"
                class="mode-pill"
                onClick={() => void loadMore()}
              >
                Retry
              </button>
            </div>
          }
        >
          <Show
            when={feedViewMode() === "strip"}
            fallback={
              <GridFeed
                illusts={illusts()}
                onLike={handleLike}
                onUnlike={handleUnlike}
                onTap={pushRelated}
              />
            }
          >
            <For each={illusts()}>
              {(illust) => (
                <FeedCard
                  illust={illust}
                  onLike={handleLike}
                  onUnlike={handleUnlike}
                  onTap={pushRelated}
                  onArtistTap={openArtist}
                  onTagsTap={setTagsIllust}
                  onTagOpen={openTagPage}
                />
              )}
            </For>
          </Show>
        </Show>

        {/* Sentinel for infinite scroll — full-height while the feed is
            empty so the initial-load spinner sits centered on screen. */}
        <div
          ref={sentinelRef}
          class={
            loading() && illusts().length === 0
              ? "feed-sentinel feed-sentinel-full"
              : "feed-sentinel"
          }
        >
          {loading() && <div class="spinner" />}
          {loadError() && !loading() && (
            <button type="button" class="mode-pill" onClick={() => void loadMore()}>
              Couldn't load — tap to retry
            </button>
          )}
          {!loading() && !loadError() && feedType() === "illustrations" && !nextUrl() && (
            <span>End of feed</span>
          )}
        </div>
      </div>

      {/* Toast: new recommendations available (or a transient error).
          Error toasts are inert — a button whose tap no-ops would be a
          lying affordance. */}
      <Show when={toast.visible() && !modalOpen()}>
        <Show
          when={toast.opens()}
          fallback={
            <div class="toast" role="status">
              {toast.text()}
            </div>
          }
        >
          <button type="button" class="toast" onClick={openRecs}>
            {toast.text()}
          </button>
        </Show>
      </Show>

      {/* Recommendations modal — its own slider, main feed untouched */}
      <Show when={modalOpen()}>
        <RecsModal
          recs={recs()}
          sourceTitle={recsSource()}
          obscured={topZ() > 0}
          onClose={() => setModalOpen(false)}
          onImageTap={pushRelated}
          onArtistTap={openArtist}
          onTagsTap={setTagsIllust}
          onTagOpen={openTagPage}
        />
      </Show>

      {/* Artist library — one at a time; related stacks push on top of it */}
      <Show when={artist()}>
        {(a) => (
          <ArtistView
            userId={a().id}
            userName={a().name}
            zIndex={a().z}
            obscured={a().z !== topZ() || artistClosing()}
            closing={artistClosing()}
            onClose={closeArtist}
            onTap={pushRelated}
            onArtistTap={openArtist}
            onTagsTap={setTagsIllust}
            onTagOpen={openTagPage}
          />
        )}
      </Show>

      {/* Search layer — its own feed, stacks/artist push on top of it */}
      <Show when={searchLayer()}>
        {(sl) => (
          <SearchScreen
            zIndex={sl().z}
            closing={searchClosing()}
            obscured={sl().z !== topZ() || searchClosing()}
            initial={searchState() ?? undefined}
            seedTag={searchSeed() ?? undefined}
            onState={setSearchState}
            onClose={closeSearch}
            onImageTap={pushRelated}
            onArtistOpen={openArtist}
            onUserOpen={openArtistUser}
            onTagsTap={setTagsIllust}
            onTagOpen={openTagPage}
          />
        )}
      </Show>

      {/* Settings (blocked tags) */}
      <Show when={configOpen()}>
        <ConfigModal onClose={() => setConfigOpen(false)} />
      </Show>

      {/* Account / login capture */}
      <Show when={loginOpen()}>
        <LoginScreen onClose={() => setLoginOpen(false)} />
      </Show>

      {/* Tag popup (gear) — lists a work's tags; tapping blocks/unblocks */}
      <Show when={tagsIllust()}>
        {(ill) => (
          <TagPopup
            illust={ill()}
            onToggle={(tag, blocked) =>
              showToast(blocked ? `Blocked #${tag}` : `Unblocked #${tag}`, false)
            }
            onClose={() => setTagsIllust(null)}
          />
        )}
      </Show>

      {/* Related-view stack — all levels stay mounted, topmost covers the
          rest, so back always restores the exact scroll position */}
      <For each={stack()}>
        {(entry, i) => (
          <RelatedView
            anchor={entry.illust}
            zIndex={entry.z}
            depth={i() + 1}
            maxDepth={MAX_STACK_DEPTH}
            closing={closingDepth() === i() + 1}
            obscured={entry.z !== topZ() || closingDepth() === i() + 1}
            onClose={popRelated}
            onCloseAll={closeAllStacks}
            onPush={pushRelated}
            onArtistTap={openArtist}
            onTagsTap={setTagsIllust}
            onTagOpen={openTagPage}
          />
        )}
      </For>
      </Show>
    </>
  );
}
