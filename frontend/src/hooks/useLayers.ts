import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { logEvent } from "../api/client";
import { DEFAULT_FILTERS } from "../components/SearchFilters";
import type { SearchState } from "../components/SearchScreen";
import type { AppSnapshot, SnapshotInput } from "../state-persistence";
import { MAX_SEARCH_DEPTH, MAX_STACK_DEPTH } from "../state-persistence";
import type { PixivIllust } from "../types";

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

/**
 * The overlay LAYER MACHINE: the related stack, the stacked search
 * pages, and the artist page — their open order (`layerSeq`), their
 * z-indexes, their close animations, and the persistence flush every
 * close owes the snapshot.
 *
 * It lives here so "what is open, in what order, and how it closes" is
 * one file instead of scattered through App's body. App keeps the gate,
 * the toast, the modal and the snapshot plumbing, and passes what the
 * machine needs in through `opts`.
 *
 * The invariants this file exists to protect (each pinned by e2e):
 *  - topZ is DERIVED (the memo below), never assigned per close path.
 *  - every close flushes persistNow SYNCHRONOUSLY before its timeout —
 *    iOS can jetsam the page during the 250ms slide-out.
 *  - close timers are idempotent: a stale timer must never clear a NEW
 *    layer opened during the animation.
 *  - an open during a close's slide-out finalizes the pending close
 *    FIRST (openSearch / openTagPage), so keys and arrays can't desync.
 */
export function useLayers(opts: {
  showToast: (msg: string, opens?: boolean) => void;
  hideToast: () => void;
  persistNow: (overrides: Partial<SnapshotInput>) => void;
  setModalOpen: (open: boolean) => void;
  setTagsIllust: (ill: PixivIllust | null) => void;
}) {
  const { showToast, hideToast, persistNow, setModalOpen, setTagsIllust } = opts;

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
    hideToast(); // don't let the toast sit hidden under the stack
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

  function restore(snap: AppSnapshot) {
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
  }

  /** Layer fields of the persisted snapshot (buildSnapshotState spreads these). */
  function layerSnapshot(): {
    stack: PixivIllust[];
    artist: { id: number; name: string } | null;
    searchStack: SearchState[];
    searchTags: (string | null)[];
    layerOrder: string[];
  } {
    return {
      stack: stack().map((s) => s.illust),
      artist: artist() ? { id: artist()!.id, name: artist()!.name } : null,
      searchStack: searchStates(),
      searchTags: searchStack().map((e) => e.tag),
      layerOrder: [...layerSeq()],
    };
  }

  return {
    // accessors
    stack,
    closingDepth,
    searchStack,
    searchStates,
    closingSearchZ,
    artist,
    artistClosing,
    layerSeq,
    topZ,
    // actions
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
    // boot + persistence
    restore,
    layerSnapshot,
  };
}
