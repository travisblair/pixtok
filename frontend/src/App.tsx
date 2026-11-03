import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { logEvent, reportApiError, setOnGateLocked, setOnRequestError } from "./api/client";
import { getStreet, getNewest, getNewestNext, getNextPage, getTop, getTopIllust, getRecommended } from "./api/feeds";
import { getBookmarkIds, getBookmarkTags, getBookmarks, getBookmarksNext, getBookmarksPrivate } from "./api/bookmarks";
import { getWorkRecs } from "./api/illust";
import { getBlockedTags, getImageSize, getFeedViewMode, getArtistViewMode, getMaxStackDepth } from "./api/prefs";
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
  setMaxStackDepthFromServer,
  maxStackDepth,
  isMaxStackDepthLoaded,
} from "./store";
import RecsModal from "./components/RecsModal";
import RelatedView from "./components/RelatedView";
import ArtistView from "./components/ArtistView";
import SearchScreen from "./components/SearchScreen";
import GateScreen from "./components/GateScreen";
import ConfigModal from "./components/ConfigModal";
import BaseModal from "./components/BaseModal";
import TagPopup from "./components/TagPopup";
import LoginScreen from "./components/LoginScreen";
import FeedHeader from "./components/FeedHeader";
import FeedArea from "./components/FeedArea";
import SelectionBar from "./components/SelectionBar";
import FeedToast from "./components/FeedToast";
import ErrorToast from "./components/ErrorToast";
import {
  loadSnapshot,
  saveSnapshot,
  MAX_STACK_DEPTH_HARD,
} from "./state-persistence";
import type { SnapshotInput } from "./state-persistence";
import { useFeedSentinel } from "./hooks/useFeedSentinel";
import { useToast } from "./hooks/useToast";
import { useEdgeBackGesture } from "./hooks/useEdgeBackGesture";
import { useLayers } from "./hooks/useLayers";
import { useBookmarkMover } from "./hooks/useBookmarkMover";
import type { MoveFailureKind, MoveResult } from "./hooks/useBookmarkMover";
import "./App.css";

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
  // True while a strip card is in immersive full-bleed — hides the feed
  // header (the card reports through FeedCard.onImmersiveChange).
  const [feedImmersive, setFeedImmersive] = createSignal(false);
  const [recs, setRecs] = createSignal<PixivIllust[]>([]);
  const [recsSource, setRecsSource] = createSignal("");
  const [modalOpen, setModalOpen] = createSignal(false);
  const toast = useToast();
  const [loadError, setLoadError] = createSignal(false);
  const [configOpen, setConfigOpen] = createSignal(false);
  const [loginOpen, setLoginOpen] = createSignal(false);
  const [tagsIllust, setTagsIllust] = createSignal<PixivIllust | null>(null);
  // Bookmarks → move-to-private failure/cancel report (BaseModal).
  const [moveReport, setMoveReport] = createSignal<MoveResult | null>(null);

  let sentinelRef: HTMLDivElement | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let reqSeq = 0; // request epoch — invalidated on feed/mode switch

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

  // Bookmarks → private mover. The queue lives HERE (not in the
  // SelectionBar) so it keeps running if the bar unmounts mid-run; only
  // leaving the bookmarks tab / switching piles aborts it, at the next
  // work boundary. Calls the shared unlike/like API functions directly —
  // never a card's toggleLike — so the bookmarks tab's unlike-removes-
  // the-card handler can't fire for moves.
  const mover = useBookmarkMover({
    onDone: (result) => {
      if (result.failures.length === 0) {
        showToast(
          `Moved ${result.moved} ${result.moved === 1 ? "work" : "works"} to private`,
          false
        );
      } else {
        showToast(
          `Move stopped — ${result.failures.length} ${
            result.failures.length === 1 ? "work" : "works"
          } not moved`,
          false
        );
        setMoveReport(result);
      }
    },
  });

  // Selection is scoped to the bookmarks tab's public pile. Leaving the
  // tab or switching to the private pile aborts at the next boundary and
  // clears the selection UI.
  createEffect(
    on(
      [feedType, bookmarkVis],
      () => {
        if (feedType() !== "bookmarks" || bookmarkVis() !== "public") {
          mover.reset();
        }
      },
      { defer: true }
    )
  );

  function moveSelectedToPrivate() {
    void mover.run([...mover.selectedIds()]);
  }

  function moveFailureLabel(kind: MoveFailureKind): string {
    switch (kind) {
      case "delete":
        return "delete failed — still public";
      case "add":
        return "re-add as private failed";
      case "cancelled":
        return "cancelled — not attempted";
    }
  }

  // The layer machine — related stack, stacked search pages, artist
  // page, their open order and close animations — lives in
  // hooks/useLayers.ts. Called here (after showToast, before the
  // gesture hook) so every const it closes over is initialized.
  const layers = useLayers({
    showToast,
    hideToast: toast.hide,
    persistNow,
    setModalOpen,
    setTagsIllust,
  });
  const {
    stack,
    closingDepth,
    searchStack,
    searchStates,
    closingSearchZ,
    artist,
    artistClosing,
    layerSeq,
    topZ,
    pushRelated,
    popRelated,
    closeAllStacks,
    openArtist,
    openArtistUser,
    closeArtist,
    openSearch,
    openTagPage,
    updateSearchState,
    closeSearch,
    popTopLayer,
  } = layers;

  function openRecs() {
    if (!toast.opens()) return; // error toasts don't open the modal
    toast.hide();
    setModalOpen(true);
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
    // Stack depth governs both the related stack and stacked search
    // pages; it also bounds the snapshot rehydrate below.
    void getMaxStackDepth()
      .then((d) => setMaxStackDepthFromServer(d.value))
      .catch(reportApiError);
    // Bookmark tags feed the bookmarks-tab pills (public list only —
    // the page's default view).
    void getBookmarkTags()
      .then((d) => setBookmarkTags(d.public))
      .catch(reportApiError);

    const snap = loadSnapshot(
      // The pref GET above is still in flight on this boot path, so the
      // default branch is the normal one: truncate at the HARD bound,
      // never the default 10 (a deep stack saved under a raised cap must
      // survive a reload). A landed pref narrows it to the live cap.
      isMaxStackDepthLoaded()
        ? { maxStackDepth: maxStackDepth(), maxSearchDepth: maxStackDepth() }
        : {
            maxStackDepth: MAX_STACK_DEPTH_HARD,
            maxSearchDepth: MAX_STACK_DEPTH_HARD,
          }
    );
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
      // Bookmarks pills are navigation state too — a reload on the Private
      // pile must not snap back to Public (the pile then looked lost).
      setBookmarkVis(snap.bookmarkVis);
      setBookmarkTag(snap.bookmarkTag);

      layers.restore(snap);

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
    void bookmarkVis();
    void bookmarkTag();
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

  // A blocked-tag change must apply to what is ALREADY on screen: the boot
  // seed lands after the first page rendered, and Settings/tag-popup edits
  // happen while the current page is visible. Without this the filter only
  // took effect on the next feed load — a blocked work stayed on screen
  // under a "Blocked #tag" toast.
  createEffect(
    on(
      blockedTags,
      (tags) => {
        if (tags.length === 0) return;
        setIllusts((prev) =>
          prev.filter((i) => filterBlockedTags([i], tags).length > 0)
        );
      },
      { defer: true }
    )
  );

  /** The full current state, as the debounced saver would write it. */
  function buildSnapshotState() {
    return {
      feedType: feedType(),
      rankContent: rankContent(),
      rankMode: rankMode(),
      newestR18: newestR18(),
      topMode: topMode(),
      bookmarkVis: bookmarkVis(),
      bookmarkTag: bookmarkTag(),
      ...layers.layerSnapshot(),
      recs: recs(),
      recsSource: recsSource(),
      modalOpen: modalOpen(),
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
  function persistNow(overrides: Partial<SnapshotInput>) {
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
        classList={{ immersive: feedImmersive() }}
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

        <Show when={feedType() === "bookmarks" && bookmarkVis() === "public"}>
          <SelectionBar
            selectionMode={mover.selectionMode}
            selectedCount={mover.selectedCount}
            running={mover.running}
            progress={mover.progress}
            onEnter={mover.enterSelection}
            onSelectAll={() => mover.selectAll(illusts().map((i) => i.id))}
            onDeselectAll={mover.deselectAll}
            onMove={moveSelectedToPrivate}
            onCancel={mover.cancel}
            onExit={mover.exitSelection}
          />
        </Show>

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
          onImmersiveChange={setFeedImmersive}
          selectable={
            feedType() === "bookmarks" &&
            bookmarkVis() === "public" &&
            mover.selectionMode()
          }
          selectedIds={mover.selectedIds()}
          onSelectToggle={mover.toggle}
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

      {/* Move-to-private report: failed / cancelled works, with the
          delete-ok-add-fail LOSS WINDOW called out explicitly. */}
      <Show when={moveReport()}>
        {(report) => (
          <BaseModal
            title="Move to private"
            closeLabel="Close move report"
            onClose={() => setMoveReport(null)}
            footer={
              <button
                type="button"
                class="mode-pill active"
                onClick={() => setMoveReport(null)}
              >
                Close
              </button>
            }
          >
            <p class="move-report-note">
              {report().moved} moved. {report().failures.length} not moved:
            </p>
            <ul class="move-report-list">
              <For each={report().failures}>
                {(failure) => (
                  <li class="move-report-item">
                    <span class="move-report-id">{failure.id}</span>
                    <span class="move-report-kind">
                      {moveFailureLabel(failure.kind)}
                    </span>
                    <Show when={failure.kind === "add"}>
                      <span class="move-report-loss">
                        bookmark removed, re-add manually
                      </span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </BaseModal>
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
            maxDepth={maxStackDepth()}
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
