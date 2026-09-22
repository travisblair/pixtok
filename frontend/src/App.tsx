import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { logEvent, reportApiError, setOnGateLocked, setOnRequestError } from "./api/client";
import { getStreet, getNewest, getNewestNext, getNextPage, getTop, getTopIllust, getRecommended } from "./api/feeds";
import { getBookmarkIds, getBookmarkTags, getBookmarks, getBookmarksNext, getBookmarksPrivate } from "./api/bookmarks";
import { getWorkRecs } from "./api/illust";
import { getBlockedTags, getImageSize, getFeedViewMode, getArtistViewMode } from "./api/prefs";
import { gateStatus } from "./api/auth";
import { uploadCrashBuffer } from "./crash-trap";
import type { ContentMode, FeedType, PixivIllust, RankingMode } from "./types";
import { isRankingMode } from "./types";
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
import FeedHeader from "./components/FeedHeader";
import FeedArea from "./components/FeedArea";
import FeedToast from "./components/FeedToast";
import ErrorToast from "./components/ErrorToast";
import {
  loadSnapshot,
  saveSnapshot,
  MAX_STACK_DEPTH,
  MAX_SEARCH_DEPTH,
} from "./state-persistence";
import { useFeedSentinel, useToast } from "./hooks";
import { useEdgeBackGesture } from "./hooks/useEdgeBackGesture";
import "./App.css";

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
  const [rankContent, setRankContent] = createSignal<ContentMode>("all");
  const [rankMode, setRankMode] = createSignal<RankingMode>("day");
  // Newest tab: all | r18 content filter.
  const [newestR18, setNewestR18] = createSignal(false);
  // Bookmarks tab: tag pills from the bookmarks page (public list) +
  // the active tag filter ("" = all bookmarks).
  const [bookmarkTags, setBookmarkTags] = createSignal<
    { name: string; count: number }[]
  >([]);
  const [bookmarkTag, setBookmarkTag] = createSignal("");
  // Public | private pile toggle. Pixtok likes are PRIVATE — the web
  // bookmarks page only lists PUBLIC ones, so the private pile needs
  // its own view (the app-API feed).
  const [bookmarkVis, setBookmarkVis] = createSignal<"public" | "private">("public");
  // Illustrations (top page) tab: all | r18.
  const [topMode, setTopMode] = createSignal<ContentMode>("all");
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
  const [artist, setArtist] = createSignal<{ id: number; name: string; z: number } | null>(null);
  const [artistClosing, setArtistClosing] = createSignal(false);
  // Stacked search layers (2026-09 multi-search): every tag tap
  // instances a NEW page on top, like the related stack. Entries are
  // STABLE ({tag,z}) so <For> never remounts a layer; each layer's
  // SearchState lives in the parallel searchStates array (same split
  // as the related stack: stable keys, content elsewhere). tag=null =
  // free-form drawer search; tag identity feeds the dedupe rule.
  const [searchStack, setSearchStack] = createSignal<
    { tag: string | null; z: number }[]
  >([]);
  const [searchStates, setSearchStates] = createSignal<SearchState[]>([]);
  // z of the search layer currently animating out; null = none.
  const [closingSearchZ, setClosingSearchZ] = createSignal<number | null>(null);
  // 1-based depth of the stack level currently animating out; null = none.
  const [closingDepth, setClosingDepth] = createSignal<number | null>(null);
  const [stack, setStack] = createSignal<{ illust: PixivIllust; z: number }[]>([]);
  let sentinelRef: HTMLDivElement | undefined;
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
    let top = 0;
    for (const key of layerSeq()) {
      if (key === "artist") {
        const artistPage = artist();
        if (artistPage && !artistClosing()) top = artistPage.z;
      } else if (key.startsWith("search")) {
        const idx = Number(key.slice(6));
        const entry = searchStack()[idx];
        if (entry && closingSearchZ() !== entry.z) top = entry.z;
      } else if (key.startsWith("s")) {
        const idx = Number(key.slice(1));
        const entry = stack()[idx];
        if (entry && closingDepth() !== idx + 1) top = entry.z;
      }
    }
    return top;
  });

  // Dev invariant: a rendered, non-closing layer must never sit above
  // topZ — that would suppress the visible layer's images. Log loudly
  // so dogfood sessions catch any future desync before it ships.
  if (import.meta.env.DEV) {
    createEffect(() => {
      const tz = topZ();
      const offenders: string[] = [];
      const artistPage = artist();
      if (artistPage && !artistClosing() && artistPage.z > tz) offenders.push(`artist(z=${artistPage.z})`);
      const sl = searchStack();
      if (sl.length > 0 && closingSearchZ() === null) {
        const topSearch = sl[sl.length - 1];
        if (topSearch.z > tz) offenders.push(`search(z=${topSearch.z})`);
      }
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
        data = await getStreet(fresh ? "" : (nextUrl() ?? ""));
      } else if (feedType() === "newest") {
        // Newest firehose: next_url is a relative /api/newest cursor URL.
        data =
          !fresh && nextUrl()
            ? await getNewestNext(nextUrl()!)
            : await getNewest(newestR18());
      } else if (feedType() === "illustrations") {
        // App-API ranking: paginated via next_url like other app feeds.
        data =
          !fresh && nextUrl()
            ? await getNextPage(nextUrl()!)
            : await getTop(rankMode());
      } else if (feedType() === "top") {
        // /illustration top page: fixed grid, no pagination.
        data = await getTopIllust(topMode());
      } else if (feedType() === "bookmarks") {
        if (bookmarkVis() === "private") {
          // App-API private pile (pixtok likes): passthrough feed, its
          // ABSOLUTE next_url rides /api/next (allowlist-validated).
          data =
            !fresh && nextUrl()
              ? await getNextPage(nextUrl()!)
              : await getBookmarksPrivate();
        } else {
          // Bookmarks PAGE (web AJAX, crawl-verified): tag-filtered with
          // blind offset pagination. next_url is self-referential
          // /api/bookmarks and must NOT ride /api/next (SSRF allowlist).
          data =
            !fresh && nextUrl()
              ? await getBookmarksNext(nextUrl()!)
              : await getBookmarks(bookmarkTag());
        }
      } else if (nextUrl() && !fresh) {
        data = await getNextPage(nextUrl()!);
      } else {
        data = await getRecommended();
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
        // Report only the CURRENT load's failure — a superseded load
        // (tab switch / reqSeq bump) used to toast for a feed the user
        // already left.
        reportApiError(err);
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
    // Tag pills are toggles: tapping the ACTIVE folder clears the filter
    // (no separate "All" pill — it duplicated the Public visibility
    // pill and read as a second toggle for the same thing).
    const next = tag === bookmarkTag() ? "" : tag;
    reqSeq++; // invalidate any in-flight load
    setBookmarkTag(next);
    resetFeedAndReload();
  }

  function changeBookmarkVis(v: "public" | "private") {
    if (v === bookmarkVis()) return;
    reqSeq++; // invalidate any in-flight load
    setBookmarkVis(v);
    setBookmarkTag(""); // tag folders don't exist in the private pile
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

  function changeRankingContent(c: ContentMode) {
    if (c === rankContent()) return;
    reqSeq++; // invalidate any in-flight load
    setRankContent(c);
    // The current mode may not exist in the new content's set — fall
    // back to the default for that row (rookie/original/AI have no
    // R-18 counterpart).
    setRankMode(c === "r18" ? "day_r18" : "day");
    resetFeedAndReload();
  }

  function changeRankingMode(m: RankingMode) {
    if (m === rankMode()) return;
    reqSeq++;
    setRankMode(m);
    resetFeedAndReload();
  }

  function changeNewestR18(c: ContentMode) {
    const isR18 = c === "r18";
    if (isR18 === newestR18()) return;
    reqSeq++;
    setNewestR18(isR18);
    resetFeedAndReload();
  }

  function changeTopMode(m: ContentMode) {
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
    logEvent("layers", "popRelated", { depth, after: depth - 1 });
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
      searchStack().length === 0 &&
      closingDepth() === null &&
      !artistClosing() &&
      closingSearchZ() === null
    ) {
      layerZ = LAYER_Z_BASE;
    }
  }

  function closeAllStacks() {
    // Stacks and the modal close; an artist page (or search layer)
    // beneath stays open and keeps its place in the open order. The
    // old code silently persisted artist:null here — a reload dropped
    // the layer you had just landed back on.
    logEvent("layers", "closeAll", { depth: stack().length });
    // WHITELIST the persistent layers. The previous prefix filter
    // (!k.startsWith("s")) also matched "search" — the ✕ removed the
    // open search layer from the open order while it stayed rendered,
    // topZ fell to 0 and every search image stayed suppressed (the
    // black-search-page-after-✕ bug; only a reload restored it).
    setLayerSeq(
      layerSeq().filter((k) => k.startsWith("search") || k === "artist")
    );
    persistNow({ stack: [], modalOpen: false });
    setStack([]);
    setModalOpen(false);
    resetLayerZIfIdle();
  }

  function openArtist(illust: PixivIllust) {
    layerZ++;
    batch(() => {
      setArtist({ id: illust.user.id, name: illust.user.name || illust.user.account, z: layerZ });
      setLayerSeq([...layerSeq(), "artist"]);
    });
  }

  // Search's artist rows carry a bare user identity (no illust object) —
  // same artist overlay, different entry shape.
  function openArtistUser(user: { id: number; name: string }) {
    layerZ++;
    batch(() => {
      setArtist({ id: user.id, name: user.name, z: layerZ });
      setLayerSeq([...layerSeq(), "artist"]);
    });
  }

  function closeArtist() {
    if (artistClosing()) return;
    logEvent("layers", "closeArtist", { layers: layerSeq().length });
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
    // An open during a close's slide-out window must finalize the
    // pending close FIRST — otherwise the exiting layer is counted in
    // searchStack().length when computing the new layer's key index, the
    // key↔array identity desyncs (topZ resolves an undefined entry), the
    // new top layer renders black, and the corruption survives reload.
    const closing = closingSearchZ();
    if (closing !== null) {
      finalizeSearchClose(closing, searchStack().findIndex((s) => s.z === closing));
    }
    if (searchStack().length >= MAX_SEARCH_DEPTH) {
      showToast(
        `Max search pages reached (${MAX_SEARCH_DEPTH}) — close one to open more`,
        false
      );
      return;
    }
    layerZ++;
    const idx = searchStack().length;
    // Batched: the dev invariant (and topZ) must never observe the
    // intermediate state where the layer exists but its key does not.
    batch(() => {
      setSearchStates([...searchStates(), makeInitialSearchState("")]);
      setSearchStack([...searchStack(), { tag: null, z: layerZ }]);
      setLayerSeq([...layerSeq(), `search${idx}`]);
    });
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

  /**
   * Tap a tag anywhere → a NEW search layer for that tag's works page
   * (multi-search: layers stack like related views). A tag already open
   * in the stack re-opens nothing — the "already open" contract, same
   * as tapping a work that's already in the related stack.
   */
  function openTagPage(tag: string) {
    setTagsIllust(null);
    // Same open-during-close flush as openSearch — see the comment there.
    const closing = closingSearchZ();
    if (closing !== null) {
      finalizeSearchClose(closing, searchStack().findIndex((s) => s.z === closing));
    }
    if (searchStack().some((s) => s.tag === tag)) {
      showToast("This tag is already open — tap Back to return to it", false);
      return;
    }
    if (searchStack().length >= MAX_SEARCH_DEPTH) {
      showToast(
        `Max search pages reached (${MAX_SEARCH_DEPTH}) — close one to open more`,
        false
      );
      return;
    }
    layerZ++;
    const idx = searchStack().length;
    batch(() => {
      setSearchStates([...searchStates(), makeInitialSearchState(tag)]);
      setSearchStack([...searchStack(), { tag, z: layerZ }]);
      setLayerSeq([...layerSeq(), `search${idx}`]);
    });
  }

  /** Report state for one search layer (index in the stack). */
  function updateSearchState(idx: number, s: SearchState) {
    setSearchStates((prev) => prev.map((e, i) => (i === idx ? s : e)));
  }

  function closeSearch(z: number) {
    if (closingSearchZ() !== null) return;
    const idx = searchStack().findIndex((s) => s.z === z);
    if (idx === -1) return;
    logEvent("layers", "closeSearch", { layers: layerSeq().length, idx });
    setClosingSearchZ(z); // play the slide-out
    // The close MUST hit the snapshot immediately (jetsam-during-animation
    // would resurrect this layer on the next reload) — same flush as every
    // other close path.
    setLayerSeq(layerSeq().filter((k) => k !== `search${idx}`));
    persistNow({
      searchStack: searchStates().filter((_, i) => i !== idx),
      searchTags: searchStack().filter((_, i) => i !== idx).map((e) => e.tag),
    });
    setTimeout(() => {
      // Superseded by an open-during-close flush: a new close for a
      // different layer may already be animating — don't clear its flag.
      if (closingSearchZ() !== z) return;
      finalizeSearchClose(z, idx);
    }, CLOSE_TIMEOUT_MS);
  }

  /** Complete a pending search-layer close immediately (idempotent). */
  function finalizeSearchClose(z: number, idx: number) {
    setSearchStack((prev) => prev.filter((s) => s.z !== z));
    setSearchStates((prev) => prev.filter((_, i) => i !== idx));
    setClosingSearchZ(null);
    resetLayerZIfIdle();
  }

  /** Pop whichever layer is topmost in the open order. */
  function popTopLayer() {
    const top = layerSeq().at(-1);
    logEvent("layers", "popTopLayer", { top, layers: layerSeq().length });
    if (top === "artist") closeArtist();
    else if (top?.startsWith("search")) {
      const idx = Number(top.slice(6));
      const entry = searchStack()[idx];
      if (entry) closeSearch(entry.z);
    }
    else if (top?.startsWith("s")) popRelated();
  }

  // A bfcache-restored page resumes a FROZEN heap — an older app state
  // (fewer layers, stale signals) with no boot and no breadcrumbs.
  // Treat the restore as stale: reload clean; the snapshot puts the
  // CURRENT layers back. persisted=true only on bfcache restores.
  function handlePageShow(e: Event) {
    if ((e as PageTransitionEvent).persisted) {
      logEvent("app", "bfcache-restored");
      location.reload();
    }
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
      const data = await getWorkRecs(illust.id, signal);
      if (data.illusts.length === 0) return;
      // Replace semantics: each like loads a fresh recs batch for the modal.
      setRecs(filterBlockedTags(data.illusts, blockedTags()));
      setRecsSource(illust.title);
      // Full title — the toast wraps (full-width bar), no truncation.
      showToast(`Recommendations for "${illust.title}"`);
    } catch (err) {
      reportApiError(err);
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
  const [gateLocked, setGateLocked] = createSignal(true);
  // Red top error toast: every failed request surfaces here for 2s
  // (tap to dismiss). Latest message wins; a burst of failures just
  // keeps restarting the timer on the same banner.
  const [errorToastMsg, setErrorToastMsg] = createSignal<string | null>(null);
  let errorToastTimer: ReturnType<typeof setTimeout> | undefined;
  function raiseErrorToast(message: string) {
    setErrorToastMsg(message);
    clearTimeout(errorToastTimer);
    errorToastTimer = setTimeout(() => setErrorToastMsg(null), 2000);
  }
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
    void getBookmarkIds()
      .then((d) => seedLikedIds(d.ids))
      .catch(reportApiError);
    void getBlockedTags()
      .then((d) => setBlockedTagsList(d.tags))
      .catch(reportApiError);
    void getImageSize()
      .then((d) => setImageSizeFromServer(d.value))
      .catch(reportApiError);
    // View modes are global prefs (server DB), not session state — they
    // seed like blocked tags and never touch the snapshot.
    void getFeedViewMode()
      .then((d) => setFeedViewModeFromServer(d.value))
      .catch(reportApiError);
    void getArtistViewMode()
      .then((d) => setArtistViewModeFromServer(d.value))
      .catch(reportApiError);
    // Bookmark tags feed the bookmarks-tab pills (public list only —
    // the page's default view).
    void getBookmarkTags()
      .then((d) => setBookmarkTags(d.public))
      .catch(reportApiError);

    const snap = loadSnapshot();
    if (snap) {
      reqSeq++; // anything an effect triggers during rehydrate gets discarded
      // Navigation + layer state restore only. The FEED is never
      // restored (user decision): content always loads fresh on boot —
      // a restored feed stranded the top of the app on old works and
      // let browsers diverge (STP vs Safari showed different feeds).
      setFeedType(snap.feedType as FeedType);
      setRankContent(snap.rankContent === "r18" ? "r18" : "all");
      setRankMode(isRankingMode(snap.rankMode) ? snap.rankMode : "day");
      setNewestR18(!!snap.newestR18);
      setTopMode(snap.topMode === "r18" ? "r18" : "all");

      // Restore overlay z-values in the SAVED open order — the stacking
      // must match the live session exactly. The old restore always put
      // the artist on top: an artist-under-stack session came back
      // flipped, and wrong obscured flags suppressed the top layer's
      // images (the recurring black-screen class).
      let restoredArtistZ = 0;
      const restoredZs: number[] = new Array(snap.stack.length).fill(0);
      const restoredSearchZs: number[] = new Array(snap.searchStack.length).fill(0);
      const order =
        snap.layerOrder.length > 0
          ? snap.layerOrder
          : [
              ...snap.searchStack.map((_, i) => `search${i}`),
              ...snap.stack.map((_, i) => `s${i}`),
              "artist",
            ];
      for (const key of order) {
        if (key.startsWith("search")) {
          const idx = Number(key.slice(6));
          if (Number.isInteger(idx) && idx >= 0 && idx < snap.searchStack.length) {
            layerZ++;
            restoredSearchZs[idx] = layerZ;
          }
        } else if (key === "artist" && snap.artist) {
          layerZ++;
          restoredArtistZ = layerZ;
        } else if (key.startsWith("s")) {
          const idx = Number(key.slice(1));
          if (Number.isInteger(idx) && idx >= 0 && idx < snap.stack.length) {
            layerZ++;
            restoredZs[idx] = layerZ;
          }
        }
      }
      // Any layer missing from the saved order still gets a z (appended
      // on top — matches "opened later" semantics).
      for (let i = 0; i < snap.searchStack.length; i++) {
        if (restoredSearchZs[i] === 0) {
          layerZ++;
          restoredSearchZs[i] = layerZ;
        }
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

      // States land FIRST: the For rows mount on the searchStack write,
      // and each row reads its initial state at mount time.
      batch(() => {
        setSearchStates(snap.searchStack);
        setSearchStack(
          snap.searchTags.map((tag, i) => ({ tag, z: restoredSearchZs[i] }))
        );
        setStack(snap.stack.map((ill, i) => ({ illust: ill, z: restoredZs[i] })));
        if (snap.artist) {
          setArtist({ id: snap.artist.id, name: snap.artist.name, z: restoredArtistZ });
        }
        setLayerSeq(
          order.filter((k) => {
            if (k.startsWith("search")) {
              const idx = Number(k.slice(6));
              return Number.isInteger(idx) && idx >= 0 && idx < snap.searchStack.length;
            }
            if (k === "artist") return !!snap.artist;
            const idx = Number(k.slice(1));
            return Number.isInteger(idx) && idx >= 0 && idx < snap.stack.length;
          })
        );
      });

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

    }
    // Fresh first page always — layers restored above, feed from scratch.
    logEvent("boot", "booted", {
      snap: !!snap,
      layers: layerSeq().length,
      feedType: feedType(),
    });
    void loadMore(true);
  }

  // Edge-back gesture: thresholds, handlers, and the document-level
  // listeners live in hooks/useEdgeBackGesture.ts. The pop action itself
  // stays here — it belongs to the layer machine.
  useEdgeBackGesture({ gateLocked, layerSeq, popTopLayer, logEvent });

  onMount(() => {
    // Mid-session gate re-lock: any later request() that hits a 403
    // "gate locked" re-shows the GateScreen (the status check below
    // only runs once at mount). Without this the app silently degrades
    // — hidden follow buttons, dead feeds — with no path back to
    // unlocking except a manual reload.
    setOnGateLocked(() => {
      logEvent("gate", "relock-mid-session");
      setGateLocked(true);
    });
    setOnRequestError(raiseErrorToast);
    // bfcache resurrection guard: iOS Safari restores back/forward
    // navigations from a frozen heap — an older page state (fewer
    // layers, stale signals) can reappear with no boot, no breadcrumbs.
    // A restored page is treated as stale: reload clean; the snapshot
    // puts the CURRENT layers back.
    window.addEventListener("pageshow", handlePageShow);
    void gateStatus()
      .then((s) => {
        logEvent("gate", s.locked ? "locked" : "open");
        if (s.locked) return; // gate screen stays up; boot on unlock
        // Flush any crash entries the previous page load left behind —
        // the ring survives reloads, and this is the first moment the
        // gate cookie guarantees /api/log will accept them.
        uploadCrashBuffer();
        setGateLocked(false);
        boot();
      })
      .catch((err) => {
        reportApiError(err);
        // Backend unreachable — show the gate; a reload re-checks.
        logEvent("gate", "unreachable");
        setGateLocked(true);
      });
  });

  // Debounced snapshot: any tracked state change re-writes the saved
  // session (500ms settle). Reads all PERSISTED signals so every change
  // is seen; the setTimeout body runs untracked, so no persistence loop.
  // Feed content (illusts/nextUrl/scroll) is intentionally NOT tracked —
  // feeds always load fresh on boot.
  createEffect(() => {
    void feedType();
    void rankContent();
    void rankMode();
    void newestR18();
    void topMode();
    void stack();
    void artist();
    void recs();
    void recsSource();
    void modalOpen();
    void searchStack();
    void searchStates();
    void gateLocked();
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      // Never snapshot while the gate is locked — the pre-boot state is
      // an empty feed, and saving it would strand the next unlock on
      // "Nothing here yet".
      if (gateLocked()) return;
      // A close animation is in flight: its sync flush already wrote the
      // post-close state, and a debounced read here sees the half-closed
      // arrays (ordering key removed, entry still present) — writing it
      // would resurrect the layer or restore it without its key. The
      // close's finalize re-triggers this effect and saves cleanly.
      if (closingDepth() !== null || closingSearchZ() !== null || artistClosing()) return;
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
      stack: stack().map((s) => s.illust),
      artist: artist() ? { id: artist()!.id, name: artist()!.name } : null,
      recs: recs(),
      recsSource: recsSource(),
      modalOpen: modalOpen(),
      searchStack: searchStates(),
      searchTags: searchStack().map((e) => e.tag),
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
    setOnRequestError(null);
    clearTimeout(errorToastTimer);
    window.removeEventListener("pageshow", handlePageShow);
  });
  useFeedSentinel(
    () => sentinelRef,
    // loadError() must gate pagination: without it, a failed page load
    // re-subscribes the observer (loading flips false) and its initial
    // callback fires immediately — an infinite 429 loop that rate-limits
    // pixiv. With the guard, a failure shows the retry button and STOPS
    // until the user taps it.
    // gateLocked() must be a tracked dependency of the sentinel effect:
    // a mid-session re-lock disposes the sentinel div, and without the
    // gate in canLoad the effect never re-runs on unlock — no observer
    // re-binds and infinite scroll stays dead until a feed switch.
    () => !!nextUrl() && !loading() && !loadError() && !gateLocked(),
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
      >
        <FeedHeader
          feedType={feedType}
          rankContent={rankContent}
          rankMode={rankMode}
          newestR18={newestR18}
          topMode={topMode}
          bookmarkVis={bookmarkVis}
          bookmarkTags={bookmarkTags}
          bookmarkTag={bookmarkTag}
          changeFeedType={changeFeedType}
          changeRankingContent={changeRankingContent}
          changeRankingMode={changeRankingMode}
          changeNewestR18={changeNewestR18}
          changeTopMode={changeTopMode}
          changeBookmarkVis={changeBookmarkVis}
          selectBookmarkTag={selectBookmarkTag}
          openSearch={openSearch}
          setConfigOpen={setConfigOpen}
          setLoginOpen={setLoginOpen}
        />

        <FeedArea
          illusts={illusts}
          loading={loading}
          loadError={loadError}
          nextUrl={nextUrl}
          feedType={feedType}
          feedViewMode={feedViewMode}
          sentinelRef={(el) => {
            sentinelRef = el;
          }}
          handleLike={handleLike}
          handleUnlike={handleUnlike}
          pushRelated={pushRelated}
          openArtist={openArtist}
          setTagsIllust={setTagsIllust}
          openTagPage={openTagPage}
          loadMore={loadMore}
        />
      </div>

      <FeedToast
        visible={toast.visible}
        opens={toast.opens}
        text={toast.text}
        modalOpen={modalOpen}
        openRecs={openRecs}
      />

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

      {/* Search layers — stacked, one per tag tap; the related stack and
          the artist page push on top of the TOPMOST search page. Each
          layer keeps its own state and closes independently. */}
      <For each={searchStack()}>
        {(entry, i) => (
          <SearchScreen
            zIndex={entry.z}
            closing={closingSearchZ() === entry.z}
            obscured={entry.z !== topZ() || closingSearchZ() === entry.z}
            initial={searchStates()[i()]}
            onState={(s) => updateSearchState(i(), s)}
            onClose={() => closeSearch(entry.z)}
            onImageTap={pushRelated}
            onArtistOpen={openArtist}
            onUserOpen={openArtistUser}
            onTagsTap={setTagsIllust}
            onTagOpen={openTagPage}
          />
        )}
      </For>

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

      <ErrorToast
        errorToastMsg={errorToastMsg}
        setErrorToastMsg={setErrorToastMsg}
      />
    </>
  );
}
