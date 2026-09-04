import { createSignal, createEffect, on, onMount, For, Show } from "solid-js";
import { api } from "../api";
import type { PixivIllust, SearchUserResult } from "../types";
import FeedCard from "./FeedCard";
import { dedupeSeen, filterBlockedTags } from "../helpers";
import { blockedTags } from "../store";
import { useFeedSentinel } from "../hooks";
import SearchFilters, {
  DEFAULT_FILTERS,
  activeFilterCount,
  type SearchFilterValues,
} from "./SearchFilters";

type SearchMode = "works" | "artists";

export interface SearchState {
  word: string;
  mode: SearchMode;
  order: string;
  contentMode: "all" | "safe" | "r18";
  workType: "all" | "illust" | "ugoira";
  sMode: string;
  aiType: "0" | "1";
  dateMode: "all" | "custom";
  scd: string;
  sce: string;
  works: PixivIllust[];
  popular: PixivIllust[];
  related: { name: string; translated_name?: string }[];
  users: SearchUserResult[];
  page: number;
  hasMore: boolean;
}

// The backend's /ajax/search/users passthrough returns 10 users per
// page (pixiv's fixed page size) — hasMore derives from that.
const USERS_PER_PAGE = 10;
// Thumbnail previews shown per artist row (pixiv shows 3 on the site).
const PREVIEWS_PER_USER = 3;

/** The user identity an artist row hands to the app on tap. */
export interface SearchUserRef {
  id: number;
  name: string;
  avatar: string;
}

/**
 * Full-screen search layer — the site's search pages, without the forced
 * tag-vs-user pre-selection: one input, Works results by default,
 * Artists behind a pill. Page 1 of Works carries the tag's popular block
 * (the search-page recommendations) + tappable related tags.
 *
 * Likes inside search are bookmark-only (no recs modal) — the heart
 * still POSTs and stays synced via the shared store.
 */
export default function SearchScreen(props: {
  zIndex: number;
  closing?: boolean;
  obscured?: boolean;
  initial?: SearchState;
  // When set, re-runs the search in place with this tag (used by App
  // to re-seed an ALREADY-OPEN search layer from a tag tap).
  seedTag?: string;
  onState?: (s: SearchState) => void;
  onClose: () => void;
  onImageTap: (illust: PixivIllust) => void;
  onArtistOpen: (illust: PixivIllust) => void;
  onUserOpen: (user: SearchUserRef) => void;
  onTagsTap: (illust: PixivIllust) => void;
  onTagOpen?: (tag: string) => void;
}) {
  const initial = props.initial;
  const [word, setWord] = createSignal(initial?.word ?? "");
  const [query, setQuery] = createSignal(initial?.word ?? "");
  const [mode, setMode] = createSignal<SearchMode>(initial?.mode ?? "works");
  const [order, setOrder] = createSignal(initial?.order ?? DEFAULT_FILTERS.order);
  const [contentMode, setContentMode] = createSignal<"all" | "safe" | "r18">(
    initial?.contentMode ?? DEFAULT_FILTERS.contentMode
  );
  const [workType, setWorkType] = createSignal<"all" | "illust" | "ugoira">(
    initial?.workType ?? DEFAULT_FILTERS.workType
  );
  const [sMode, setSMode] = createSignal(initial?.sMode ?? DEFAULT_FILTERS.sMode);
  const [aiType, setAIType] = createSignal<"0" | "1">(initial?.aiType ?? DEFAULT_FILTERS.aiType);
  const [dateMode, setDateMode] = createSignal<"all" | "custom">(
    initial?.dateMode ?? (initial?.scd || initial?.sce ? "custom" : "all")
  );
  const [scd, setScd] = createSignal(initial?.scd ?? "");
  const [sce, setSce] = createSignal(initial?.sce ?? "");
  const [filtersOpen, setFiltersOpen] = createSignal(false);

  const [works, setWorks] = createSignal<PixivIllust[]>(initial?.works ?? []);
  const [popular, setPopular] = createSignal<PixivIllust[]>(initial?.popular ?? []);
  const [related, setRelated] = createSignal<{ name: string; translated_name?: string }[]>(
    initial?.related ?? []
  );
  const [users, setUsers] = createSignal<SearchUserResult[]>(initial?.users ?? []);
  const [page, setPage] = createSignal(initial?.page ?? 0);
  const [hasMore, setHasMore] = createSignal(initial?.hasMore ?? false);

  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [loadMoreError, setLoadMoreError] = createSignal(false);

  let sentinelRef: HTMLDivElement | undefined;
  let reqSeq = 0;
  const seen = new Set<number>(
    initial ? initial.works.map((w) => w.id) : []
  );

  async function runSearch(fresh: boolean) {
    const term = query().trim();
    if (!term) return;
    // NOTE: no loading() early-return here. Each call takes the seq —
    // a new call invalidates any in-flight run (its finally skips
    // setLoading) and owns the spinner itself. The old guard +
    // seq-skip combo could strand loading=true forever: switchMode
    // bumped reqSeq mid-flight, the stale run's finally skipped
    // setLoading(false), and the new run was blocked by the guard —
    // endless spinner with zero requests.
    const seq = ++reqSeq;
    setLoading(true);
    setError(false);
    setLoadMoreError(false);
    try {
      if (mode() === "works") {
        const nextPage = fresh ? 1 : page() + 1;
        const data = await api.searchArtworks({
          word: term,
          order: order(),
          contentMode: contentMode(),
          workType: workType(),
          sMode: sMode(),
          aiType: aiType(),
          scd: scd(),
          sce: sce(),
          p: nextPage,
        });
        if (seq !== reqSeq) return;
        // A fresh search/order change starts a NEW result set — reset
        // the dedupe memory or the new page 1 gets eaten by ids seen in
        // the previous search (cross-search dedupe).
        if (fresh) seen.clear();
        const freshWorks = dedupeSeen(seen, filterBlockedTags(data.illusts, blockedTags()));
        if (fresh) {
          setWorks(freshWorks);
          setPopular(data.popular);
          setRelated(data.related_tags);
        } else {
          setWorks((prev) => [...prev, ...freshWorks]);
        }
        setPage(nextPage);
        setHasMore(nextPage < data.last_page);
      } else {
        const nextPage = fresh ? 1 : page() + 1;
        const data = await api.searchUsers(term, nextPage);
        if (seq !== reqSeq) return;
        if (fresh) {
          setUsers(data.users);
        } else {
          setUsers((prev) => [...prev, ...data.users]);
        }
        setPage(nextPage);
        setHasMore(nextPage * USERS_PER_PAGE < data.total);
      }
      // A fresh search starts a NEW result set — jump back to the top
      // so the page-1 popular/tags rows and the first results are
      // visible (the container would otherwise keep its old deep
      // scroll position across re-searches). The typeof guard keeps
      // jsdom (no Element.scrollTo) from throwing inside the search
      // try-block and masquerading as an upstream failure.
      if (fresh) {
        const container = sentinelRef?.closest<HTMLElement>(".feed-container");
        if (container && typeof container.scrollTo === "function") container.scrollTo({ top: 0 });
      }
    } catch (err) {
      if (seq === reqSeq) {
        console.error("Search failed:", err);
        if (fresh) {
          setError(true);
          // A failed fresh search must not leave the PREVIOUS query's
          // pagination live: hasMore/page still described the old result
          // set, so the sentinel could fetch page N+1 of the NEW query
          // and append it to the OLD query's results.
          setHasMore(false);
          setPage(0);
        } else {
          setLoadMoreError(true);
        }
      }
    } finally {
      if (seq === reqSeq) setLoading(false);
    }
  }

  function submit(e: Event) {
    e.preventDefault();
    const term = word().trim();
    if (!term) return;
    setQuery(term);
    void runSearch(true);
  }

  function switchMode(m: SearchMode) {
    if (m === mode()) return;
    setMode(m);
    // Re-run the current query in the other mode. runSearch takes the
    // seq and invalidates any in-flight run itself.
    if (query()) void runSearch(true);
  }

  function changeFilter(patch: Partial<SearchFilterValues>) {
    if ("order" in patch) setOrder(patch.order!);
    if ("contentMode" in patch) setContentMode(patch.contentMode!);
    if ("workType" in patch) setWorkType(patch.workType!);
    if ("sMode" in patch) setSMode(patch.sMode!);
    if ("aiType" in patch) setAIType(patch.aiType!);
    if ("dateMode" in patch) setDateMode(patch.dateMode!);
    if ("scd" in patch) setScd(patch.scd!);
    if ("sce" in patch) setSce(patch.sce!);
    if (query()) void runSearch(true);
  }

  function resetFilters() {
    setOrder(DEFAULT_FILTERS.order);
    setContentMode(DEFAULT_FILTERS.contentMode);
    setWorkType(DEFAULT_FILTERS.workType);
    setSMode(DEFAULT_FILTERS.sMode);
    setAIType(DEFAULT_FILTERS.aiType);
    setDateMode("all");
    setScd("");
    setSce("");
    if (query()) void runSearch(true);
  }

  function filterCount(): number {
    // Reads all filter signals — the Show-when memo below tracks them
    // at its call site, so the badge re-computes on any filter change.
    return activeFilterCount({
      order: order(),
      contentMode: contentMode(),
      workType: workType(),
      sMode: sMode(),
      aiType: aiType(),
      dateMode: dateMode(),
      scd: scd(),
      sce: sce(),
    });
  }

  function searchRelatedTag(tag: string) {
    setWord(tag);
    setQuery(tag);
    void runSearch(true);
  }

  // Re-seed from App: a tag tap while this layer is already open.
  createEffect(
    on(
      () => props.seedTag,
      (t) => {
        if (t) searchRelatedTag(t);
      },
      { defer: true }
    )
  );

  function loadMore() {
    if (hasMore() && !loading()) void runSearch(false);
  }

  // Report state for snapshot persistence (debounced at the App level).
  createEffect(() => {
    props.onState?.({
      word: word(),
      mode: mode(),
      order: order(),
      contentMode: contentMode(),
      workType: workType(),
      sMode: sMode(),
      aiType: aiType(),
      dateMode: dateMode(),
      scd: scd(),
      sce: sce(),
      works: works(),
      popular: popular(),
      related: related(),
      users: users(),
      page: page(),
      hasMore: hasMore(),
    });
  });

  // Auto-run: a RESTORED query without results refetches once per mount.
  // onMount, NOT a createEffect — a reactive effect subscribed to
  // query()/works()/loading() could interleave with the user's submit
  // in a real browser and double-fire the search (two identical
  // upstream calls; caught by the e2e search spec).
  onMount(() => {
    if (initial && query() && works().length === 0 && users().length === 0) {
      void runSearch(true);
    }
  });

  useFeedSentinel(
    () => sentinelRef,
    // loadMoreError gates pagination: a failed page must stop
    // auto-firing (same re-subscribe storm as App.tsx) and wait for the
    // retry button instead.
    () => hasMore() && !loading() && !loadMoreError(),
    loadMore
  );

  const imgUrl = (u: string | undefined) =>
    u ? `/api/img?url=${encodeURIComponent(u)}` : "";

  return (
    <div
      class={props.closing ? "search-screen exit" : "search-screen enter"}
      style={{ "z-index": props.zIndex }}
    >
      <div class="search-header">
        <div class="search-top-row">
          <button type="button" class="related-back overlay-pill" onClick={props.onClose} aria-label="Back">
            ← Back
          </button>
          <form class="search-form" onSubmit={submit}>
            <input
              type="text"
              class="search-input"
              value={word()}
              onInput={(e) => setWord((e.currentTarget as HTMLInputElement).value)}
              placeholder="Search works and artists"
              aria-label="Search works and artists"
              autocomplete="off"
            />
            <button type="submit" class="mode-pill" disabled={!word().trim()}>
              Search
            </button>
          </form>
        </div>
        <div class="search-pills no-scrollbar fade-edges">
          <button
            type="button"
            class={mode() === "works" ? "mode-pill active" : "mode-pill"}
            onClick={() => switchMode("works")}
          >
            Works
          </button>
          <button
            type="button"
            class={mode() === "artists" ? "mode-pill active" : "mode-pill"}
            onClick={() => switchMode("artists")}
          >
            Artists
          </button>
          <Show when={mode() === "works"}>
            <button
              type="button"
              class="mode-pill filter-button"
              onClick={() => setFiltersOpen(true)}
              aria-label="Search filters"
            >
              Filters
              <Show when={filterCount() > 0}>
                <span class="filter-badge">{filterCount()}</span>
              </Show>
            </button>
          </Show>
        </div>
      </div>

      {/* NOTE: && not <Show> — a Show child memoizes its subtree and
          stays a static snapshot of the values at open time. The &&
          form re-creates SearchFilters on every SearchScreen render, so
          pills/date inputs track live filter state (verified: Show kept
          "Newest" active after picking Oldest, badge updated but modal
          didn't). Values pass as ACCESSORS so the modal's bindings are
          reactive regardless of parent render granularity. */}
      {filtersOpen() && (
        <SearchFilters
          values={{
            order,
            contentMode,
            workType,
            sMode,
            aiType,
            dateMode,
            scd,
            sce,
          }}
          onPick={changeFilter}
          onReset={resetFilters}
          onClose={() => setFiltersOpen(false)}
        />
      )}

      <div class="feed-container">
        <Show when={mode() === "works"}>
          {/* Page 1 carries the tag's recommendations + related tags. */}
          <Show when={page() === 1 && popular().length > 0 && !loading()}>
            <div class="search-section-label">Popular for this search</div>
            <div class="search-popular-strip no-scrollbar fade-edges">
              <For each={popular()}>
                {(ill) => (
                  <button
                    type="button"
                    class="search-popular-item"
                    onClick={() => props.onImageTap(ill)}
                    aria-label={ill.title}
                  >
                    <img
                      src={imgUrl(ill.image_urls.square_medium ?? ill.image_urls.large)}
                      alt={ill.title}
                      loading="lazy"
                    />
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={page() === 1 && related().length > 0 && !loading()}>
            <div class="search-related-row no-scrollbar fade-edges">
              <For each={related()}>
                {(t) => (
                  <button
                    type="button"
                    class="mode-pill search-related-pill"
                    onClick={() => searchRelatedTag(t.name)}
                  >
                    #{t.name}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <For each={works()}>
            {(illust) => (
              <FeedCard
                illust={illust}
                onTap={props.onImageTap}
                onArtistTap={props.onArtistOpen}
                onTagsTap={props.onTagsTap}
                onTagOpen={props.onTagOpen}
                suppressImages={props.obscured || props.closing}
              />
            )}
          </For>
        </Show>

        <Show when={mode() === "artists"}>
          <For each={users()}>
            {(u) => (
              <div class="search-user-row">
                <button
                  type="button"
                  class="search-user-main"
                  onClick={() =>
                    props.onUserOpen({
                      id: u.id,
                      name: u.name,
                      avatar: u.avatar,
                    })
                  }
                >
                  <img class="search-user-avatar" src={imgUrl(u.avatar)} alt={u.name} />
                  <span class="search-user-name">{u.name}</span>
                </button>
                <div class="search-user-previews">
                  <For each={u.previews.slice(0, PREVIEWS_PER_USER)}>
                    {(p) => (
                      <button
                        type="button"
                        class="search-user-preview"
                        onClick={() => props.onImageTap(p)}
                        aria-label={p.title}
                      >
                        <img
                          src={imgUrl(p.image_urls.square_medium ?? p.image_urls.large)}
                          alt={p.title}
                          loading="lazy"
                        />
                      </button>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </Show>

        <Show when={!query()}>
          <div class="empty-feed">
            <span>Search pixiv — works, tags, or artists</span>
          </div>
        </Show>

        <div ref={sentinelRef} class="feed-sentinel">
          {loading() && <div class="spinner" />}
          {error() && !loading() && (
            <span>Couldn't search — try again</span>
          )}
          {loadMoreError() && !loading() && (
            <button type="button" class="mode-pill" onClick={loadMore}>
              Couldn't load — tap to retry
            </button>
          )}
          {!hasMore() && !loading() && query() && mode() === "works" && works().length > 0 && (
            <span>End of results</span>
          )}
          {!loading() && !error() && query() && !loadMoreError() &&
            ((mode() === "works" && works().length === 0) ||
              (mode() === "artists" && users().length === 0)) && (
            <span>No results for "{query()}"</span>
          )}
        </div>
      </div>
    </div>
  );
}
