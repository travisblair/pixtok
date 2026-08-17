import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import App from "./App";
import { makeFeedOf, makeFeed, makeIllust } from "./test-fixtures";

vi.mock("./api", () => ({
  api: {
    getStreet: vi.fn(),
    getTop: vi.fn(),
    getRecommended: vi.fn(),
    getWorkRecs: vi.fn(),
    getNextPage: vi.fn(),
    getRelated: vi.fn(),
    getUserIllusts: vi.fn(),
    getUgoiraMeta: vi.fn(),
    getAuthStatus: vi.fn(),
    getBookmarkIds: vi.fn(),
    getBlockedTags: vi.fn(),
    setBlockedTags: vi.fn(async () => {}),
    getImageSize: vi.fn(),
    setImageSize: vi.fn(async () => {}),
    getFeedViewMode: vi.fn(),
    setFeedViewMode: vi.fn(async () => {}),
    getArtistViewMode: vi.fn(),
    setArtistViewMode: vi.fn(async () => {}),
    gateStatus: vi.fn(),
    gateUnlock: vi.fn(async () => {}),
    getBookmarks: vi.fn(),
    getBookmarksNext: vi.fn(),
    getBookmarkTags: vi.fn(),
    searchArtworks: vi.fn(),
    searchUsers: vi.fn(),
    like: vi.fn(async () => {}),
    unlike: vi.fn(async () => {}),
    follow: vi.fn(async () => {}),
    unfollow: vi.fn(async () => {}),
    getFollowed: vi.fn(),
  },
}));

import { api } from "./api";
const mockedApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  // Session snapshots must not leak between tests (a leftover
  // pixtok_state_v2 would make later renders rehydrate instead of
  // loading the street feed).
  localStorage.clear();
  // Distinct id ranges per feed so cross-feed bleed is visible in
  // assertions (street 1.., top 1000.., recommended/workRecs 500..,
  // related 900..).
  mockedApi.getStreet
    .mockReset()
    .mockResolvedValue(makeFeedOf(30, 1));
  mockedApi.getTop.mockReset().mockResolvedValue(makeFeedOf(30, 1000));
  mockedApi.getRecommended
    .mockReset()
    .mockResolvedValue(makeFeedOf(5, 500));
  mockedApi.getWorkRecs
    .mockReset()
    .mockResolvedValue(makeFeedOf(5, 500));
  mockedApi.getNextPage.mockReset().mockResolvedValue(makeFeedOf(10, 100));
  mockedApi.getRelated.mockReset().mockResolvedValue(makeFeedOf(8, 900));
  mockedApi.getUserIllusts.mockReset().mockResolvedValue(makeFeedOf(6, 600));
  mockedApi.getUgoiraMeta
    .mockReset()
    .mockResolvedValue({ error: false, body: { src: "z", frames: [] } });
  mockedApi.getAuthStatus
    .mockReset()
    .mockResolvedValue({ app_api: true, web_session: true });
  mockedApi.getBookmarkIds.mockReset().mockResolvedValue({ ids: [] });
  mockedApi.getBlockedTags.mockReset().mockResolvedValue({ tags: [] });
  mockedApi.setBlockedTags.mockReset().mockResolvedValue(undefined);
  mockedApi.getImageSize.mockReset().mockResolvedValue({ value: "large" });
  mockedApi.setImageSize.mockReset().mockResolvedValue(undefined);
  mockedApi.getFeedViewMode.mockReset().mockResolvedValue({ value: "strip" });
  mockedApi.setFeedViewMode.mockReset().mockResolvedValue(undefined);
  mockedApi.getArtistViewMode
    .mockReset()
    .mockResolvedValue({ value: "strip" });
  mockedApi.setArtistViewMode.mockReset().mockResolvedValue(undefined);
  mockedApi.gateStatus.mockReset().mockResolvedValue({ locked: false });
  mockedApi.gateUnlock.mockReset().mockResolvedValue({ ok: true });
  mockedApi.getBookmarks
    .mockReset()
    .mockResolvedValue(makeFeedOf(8, 4000));
  mockedApi.getBookmarksNext
    .mockReset()
    .mockResolvedValue({ illusts: [], next_url: null });
  mockedApi.getBookmarkTags
    .mockReset()
    .mockResolvedValue({ public: [], private: [] });
  mockedApi.follow.mockReset().mockResolvedValue({ ok: true });
  mockedApi.unfollow.mockReset().mockResolvedValue({ ok: true });
  mockedApi.getFollowed.mockReset().mockResolvedValue({ followed: false });
  mockedApi.searchArtworks.mockReset().mockResolvedValue({
    illusts: makeFeedOf(3, 2000).illusts,
    total: 900,
    last_page: 1,
    page: 1,
    next_url: null,
    popular: [],
    related_tags: [],
  });
  mockedApi.searchUsers.mockReset().mockResolvedValue({
    users: [],
    total: 0,
    page: 1,
    next_url: null,
  });
  mockedApi.like.mockReset().mockResolvedValue(undefined);
  mockedApi.unlike.mockReset().mockResolvedValue(undefined);
});

describe("App", () => {
  it("loads the street feed on mount", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    expect(mockedApi.getStreet).toHaveBeenCalledWith("");
  });

  it("restores a saved session instead of loading any feed", async () => {
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "recommended",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        illusts: makeFeedOf(9, 700).illusts,
        nextUrl: null,
        scrollTop: 0,
        stack: [],
        artist: null,
        recs: [],
        recsSource: "",
        modalOpen: false,
      })
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(9)
    );
    // No network on rehydrate — the saved cards ARE the feed.
    expect(mockedApi.getStreet).not.toHaveBeenCalled();
    expect(mockedApi.getRecommended).not.toHaveBeenCalled();
  });

  it("self-heals an empty snapshot saved while the gate was locked", async () => {
    // Regression: the gate-locked (or HMR-churn) state saved an empty
    // feed snapshot; restoring it stranded the app on "Nothing here
    // yet" after unlock. An empty, cursorless snapshot loads fresh.
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "home",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        illusts: [],
        nextUrl: null,
        scrollTop: 0,
        stack: [],
        artist: null,
        recs: [],
        recsSource: "",
        modalOpen: false,
        searchOpen: false,
        search: null,
      })
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    expect(mockedApi.getStreet).toHaveBeenCalledWith("");
  });

  it("restores an open artist page from the snapshot", async () => {
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "home",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        illusts: makeFeedOf(9, 700).illusts,
        nextUrl: null,
        scrollTop: 0,
        stack: [],
        artist: { id: 777, name: "RestoredArtist" },
        recs: [],
        recsSource: "",
        modalOpen: false,
      })
    );
    const { container } = render(() => <App />);
    // The artist view remounts and refetches that artist's works.
    await waitFor(() =>
      expect(container.querySelector(".artist-view")).not.toBeNull()
    );
    await waitFor(() =>
      expect(container.querySelector(".artist-name-badge")?.textContent).toBe(
        "RestoredArtist"
      )
    );
    expect(mockedApi.getUserIllusts).toHaveBeenCalledWith(777);
    expect(mockedApi.getStreet).not.toHaveBeenCalled();
  });

  it("restores an open recs modal with images loading (not suppressed)", async () => {
    // Regression: the rehydrate path used to bump topZ to the modal's
    // z-index, which made obscured=true and suppressed every modal image
    // (permanent black cards, unfixable by reloading because the
    // snapshot keeps modalOpen=true).
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "home",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        illusts: [],
        nextUrl: null,
        scrollTop: 0,
        stack: [],
        artist: null,
        recs: makeFeedOf(4, 400).illusts,
        recsSource: "The source",
        modalOpen: true,
      })
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelector(".recs-modal")).not.toBeNull()
    );
    // Activation is distance-delayed (setTimeout), so wait for the real
    // src to replace the pixel placeholder.
    await waitFor(() =>
      expect(
        container.querySelector(".recs-modal img.card-image")?.getAttribute("src")
      ).toContain("/api/img")
    );
  });

  it("restores artist + stack with the artist on top loading images", async () => {
    // Regression: the rehydrate topZ pointed at the stack top even
    // though the restored artist holds the HIGHEST z — the artist page
    // marked itself obscured and rendered black (same class as the recs
    // modal bug).
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "home",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        illusts: makeFeedOf(9, 700).illusts,
        nextUrl: null,
        scrollTop: 0,
        stack: makeFeedOf(1, 900).illusts,
        artist: { id: 777, name: "RestoredArtist" },
        recs: [],
        recsSource: "",
        modalOpen: false,
      })
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelector(".artist-view")).not.toBeNull()
    );
    await waitFor(() =>
      expect(
        container.querySelector(".artist-view img.card-image")?.getAttribute("src")
      ).toContain("/api/img")
    );
  });

  it("Search item opens the search layer and searches", async () => {
    const { getByText, container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("🔍 Search"));
    await waitFor(() =>
      expect(container.querySelector(".search-screen")).not.toBeNull()
    );
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(mockedApi.searchArtworks).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelectorAll(".search-screen .feed-card").length).toBe(3)
    );
  });

  it("restores an open search layer from the snapshot", async () => {
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "home",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        illusts: makeFeedOf(9, 700).illusts,
        nextUrl: null,
        scrollTop: 0,
        stack: [],
        artist: null,
        recs: [],
        recsSource: "",
        modalOpen: false,
        searchOpen: true,
        search: {
          word: "fantasy",
          mode: "works",
          order: "date_d",
          contentMode: "all",
          works: makeFeedOf(3, 3000).illusts,
          popular: [],
          related: [],
          users: [],
          page: 1,
          hasMore: false,
        },
      })
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelector(".search-screen")).not.toBeNull()
    );
    expect(
      (container.querySelector(".search-input") as HTMLInputElement).value
    ).toBe("fantasy");
    await waitFor(() =>
      expect(container.querySelectorAll(".search-screen .feed-card").length).toBe(3)
    );
    // Restored works render verbatim — no refetch.
    expect(mockedApi.searchArtworks).not.toHaveBeenCalled();
  });

  it("Bookmarks tab loads the user's bookmarked works", async () => {
    const { getByText, container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Bookmarks"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(8)
    );
    expect(mockedApi.getBookmarks).toHaveBeenCalled();
  });

  it("locks behind the gate and boots after unlocking", async () => {
    mockedApi.gateStatus.mockResolvedValue({ locked: true });
    const { container } = render(() => <App />);

    // Gate up, nothing boots.
    await waitFor(() =>
      expect(container.querySelector(".gate-screen")).not.toBeNull()
    );
    expect(mockedApi.getStreet).not.toHaveBeenCalled();

    // Unlock → gate clears and the feed loads.
    const input = container.querySelector(".gate-form input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "letmein" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(container.querySelector(".gate-screen")).toBeNull()
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    expect(mockedApi.gateUnlock).toHaveBeenCalledWith("letmein");
  });

  it("persists the session as the user navigates", async () => {
    const { getByText, container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Discover"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(5)
    );
    // Let the 500ms debounce fire for real.
    await new Promise((r) => setTimeout(r, 650));

    const saved = JSON.parse(localStorage.getItem("pixtok_state_v2")!);
    expect(saved.feedType).toBe("recommended");
    expect(saved.illusts.length).toBe(5);
  });

  it("home shows no mode pills; Ranking tab does", async () => {
    const { container, getByText } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    expect(container.querySelector(".mode-selector")).toBeNull();

    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Ranking"));
    await waitFor(() =>
      expect(container.querySelector(".mode-selector")).not.toBeNull()
    );
    expect(mockedApi.getTop).toHaveBeenCalledWith("day");
  });

  it("switching to R18 on the Ranking tab refetches with mode=day_r18", async () => {
    mockedApi.getTop.mockImplementation(async (mode: string) =>
      mode === "day_r18" ? makeFeedOf(12, 9000) : makeFeedOf(30, 1)
    );
    const { getByText, container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Ranking"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    await fireEvent.click(getByText("R18"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(12)
    );
    expect(mockedApi.getTop).toHaveBeenCalledWith("day_r18");
  });

  it("switching the ranking mode pill refetches with the new mode", async () => {
    const modes: string[] = [];
    mockedApi.getTop.mockImplementation(async (mode: string) => {
      modes.push(mode);
      return makeFeedOf(30, 1);
    });
    const { getByText, container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Ranking"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    await fireEvent.click(getByText("Weekly"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    expect(modes).toContain("week");
  });

  it("switching to Discover loads the recommended feed", async () => {
    mockedApi.getRecommended.mockResolvedValue(makeFeedOf(9, 700));
    const { getByText, container } = render(() => <App />);

    // The app UI mounts once the gate check clears — wait for it.
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Discover"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(9)
    );
    expect(mockedApi.getRecommended).toHaveBeenCalled();
  });

  it("Account item opens the login screen with auth status", async () => {
    const { getByText, container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("👤 Account"));

    await waitFor(() =>
      expect(container.querySelector(".auth-status")).not.toBeNull()
    );
    expect(mockedApi.getAuthStatus).toHaveBeenCalled();
    await waitFor(() =>
      // Connected banner + two green surface rows when fully authed.
      expect(container.querySelectorAll(".auth-status.ok").length).toBe(3)
    );
  });

  it("shows the retry button and recovers after a failed first load", async () => {
    mockedApi.getStreet
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(makeFeedOf(5, 1));
    const { getByText, container } = render(() => <App />);

    await waitFor(() => expect(getByText("Retry")).toBeTruthy());
    await fireEvent.click(getByText("Retry"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(5)
    );
  });

  it("discards an in-flight street load when the user switches tabs", async () => {
    let resolveStreet!: (v: ReturnType<typeof makeFeedOf>) => void;
    mockedApi.getStreet.mockImplementation(
      () =>
        new Promise((res) => {
          resolveStreet = res;
        })
    );
    const { container, getByText } = render(() => <App />);
    await waitFor(() => expect(mockedApi.getStreet).toHaveBeenCalled());

    // Switch to Discover while the street load is still pending.
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Discover"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(5)
    );

    // The stale street response arrives AFTER the switch — discarded.
    resolveStreet(makeFeedOf(30, 1));
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelectorAll(".feed-card").length).toBe(5);
    expect(mockedApi.getNextPage).not.toHaveBeenCalled();
  });

  it("no toast when the liked work has no recommendations", async () => {
    mockedApi.getWorkRecs.mockResolvedValue(makeFeedOf(0, 0));
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    await fireEvent.click(container.querySelector(".like-btn")!);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".toast")).toBeNull();
  });

  it("shows an error toast when recommendations fail to load", async () => {
    mockedApi.getWorkRecs.mockRejectedValue(new Error("boom"));
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    await fireEvent.click(container.querySelector(".like-btn")!);
    await waitFor(() =>
      expect(container.querySelector(".toast")?.textContent).toContain(
        "Couldn't load recommendations"
      )
    );
  });

  it("like state is shared between the main feed and stack cards", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Like the first card in the main feed.
    const mainHeart = container.querySelector(".feed-card .like-btn")!;
    await fireEvent.click(mainHeart);
    await waitFor(() => expect(mainHeart.textContent).toBe("❤️"));

    // Tap it to open the stack — the anchor card must show the same heart.
    const firstCard = container.querySelector(".feed-card")!;
    await fireEvent.click(firstCard.querySelector(".card-overlay")!);
    await waitFor(() =>
      expect(container.querySelector(".related-view")).toBeTruthy()
    );
    const anchorHeart = container.querySelector(
      ".related-view .feed-card .like-btn"
    )!;
    expect(anchorHeart.textContent).toBe("❤️");

    // Unlike inside the stack — the main feed heart must revert too.
    await fireEvent.click(anchorHeart);
    await waitFor(() => expect(anchorHeart.textContent).toBe("🤍"));
    expect(mainHeart.textContent).toBe("🤍");
  });

  it("toast announces the cap instead of silently dropping stack pushes", async () => {
    // Each level gets UNIQUE related ids so the stack dedupe doesn't
    // (correctly) refuse the push.
    let level = 0;
    mockedApi.getRelated.mockImplementation(async () =>
      makeFeedOf(8, 900 + level++ * 100)
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Push 10 levels (the max) — tap a related work, never the anchor.
    for (let i = 0; i < 10; i++) {
      const topCard = container.querySelector(".related-view")
        ? container.querySelectorAll(".related-view:last-of-type .feed-card")[1]
        : container.querySelectorAll(".feed-card")[0];
      await fireEvent.click(topCard.querySelector(".card-overlay")!);
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(container.querySelectorAll(".related-view").length).toBe(10);

    // The 11th tap must not silently vanish — a toast explains the cap.
    const topCard = container.querySelectorAll(
      ".related-view:last-of-type .feed-card"
    )[1];
    await fireEvent.click(topCard.querySelector(".card-overlay")!);
    await waitFor(() =>
      expect(container.querySelector(".toast")?.textContent).toContain(
        "Max stack depth"
      )
    );
    expect(container.querySelectorAll(".related-view").length).toBe(10);
  });

  it("toast names the work whose recommendations loaded", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    await fireEvent.click(container.querySelector(".like-btn")!);
    await waitFor(() =>
      expect(container.querySelector(".toast")?.textContent).toContain(
        "Recommendations for"
      )
    );
  });

  it("liking a card shows the toast, which opens the recs modal", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    await fireEvent.click(container.querySelector(".like-btn")!);
    await waitFor(() => expect(container.querySelector(".toast")).toBeTruthy());
    // per-work recommendations for the liked card, with an abort signal
    expect(mockedApi.getWorkRecs).toHaveBeenCalledWith(1, expect.any(AbortSignal));

    await fireEvent.click(container.querySelector(".toast")!);
    await waitFor(() =>
      expect(container.querySelector(".recs-modal")).toBeTruthy()
    );
    expect(
      container.querySelectorAll(".recs-modal .feed-card").length
    ).toBe(5); // getWorkRecs mock returns 5 works
  });

  it("tapping a card pushes a related view anchored on that card", async () => {
    mockedApi.getRelated.mockResolvedValue(makeFeedOf(8, 900));
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    const firstCard = container.querySelector(".feed-card")!;
    await fireEvent.click(firstCard.querySelector(".card-overlay")!);

    await waitFor(() =>
      expect(container.querySelector(".related-view")).toBeTruthy()
    );
    const rvCards = container.querySelectorAll(
      ".related-view .feed-card"
    );
    expect(rvCards.length).toBe(9); // anchor + 8 related
  });

  it("first stack open shows the one-time hint; Got it dismisses it forever", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    await fireEvent.click(
      container.querySelector(".feed-card .card-overlay")!
    );
    await waitFor(() =>
      expect(container.querySelector(".stack-hint")).toBeTruthy()
    );

    await fireEvent.click(
      container.querySelector(".stack-hint button")!
    );
    expect(container.querySelector(".stack-hint")).toBeNull();

    // Back, then open a DIFFERENT stack — the hint stays gone.
    await fireEvent.click(container.querySelector(".related-back")!);
    await waitFor(() =>
      expect(container.querySelectorAll(".related-view").length).toBe(0)
    );
    await fireEvent.click(
      container.querySelectorAll(".feed-card")[1].querySelector(".card-overlay")!
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".related-view").length).toBe(1)
    );
    expect(container.querySelector(".stack-hint")).toBeNull();
  });

  it("back plays the slide-out before popping the level", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    await fireEvent.click(
      container.querySelector(".feed-card .card-overlay")!
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".related-view").length).toBe(1)
    );

    await fireEvent.click(container.querySelector(".related-back")!);
    // Immediately: still mounted, but in the exit state.
    expect(
      container.querySelector(".related-view")?.className
    ).toContain("exit");
    // After the animation window: gone.
    await waitFor(
      () =>
        expect(container.querySelectorAll(".related-view").length).toBe(0),
      { timeout: 2000 }
    );
  });

  it("artist page opened from INSIDE a stack lands above it", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Open a stack (takes the next layer).
    await fireEvent.click(
      container.querySelector(".feed-card .card-overlay")!
    );
    await waitFor(() =>
      expect(container.querySelector(".related-view")).toBeTruthy()
    );

    // Tap an artist name inside the stack.
    await fireEvent.click(
      container.querySelector(".related-view .card-artist a")!
    );
    await waitFor(() =>
      expect(container.querySelector(".artist-view")).toBeTruthy()
    );

    const rvZ = parseInt(
      (container.querySelector(".related-view") as HTMLElement).style
        .zIndex,
      10
    );
    const avZ = parseInt(
      (container.querySelector(".artist-view") as HTMLElement).style
        .zIndex,
      10
    );
    expect(avZ).toBeGreaterThan(rvZ); // artist page must cover the stack
  });

  it("covered stack layers unload images; back restores the top layer's", async () => {
    let level = 0;
    mockedApi.getRelated.mockImplementation(async () =>
      makeFeedOf(8, 900 + level++ * 100)
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Push two levels.
    for (let i = 0; i < 2; i++) {
      const topCard = container.querySelector(".related-view")
        ? container.querySelectorAll(".related-view:last-of-type .feed-card")[1]
        : container.querySelectorAll(".feed-card")[0];
      await fireEvent.click(topCard.querySelector(".card-overlay")!);
      await new Promise((r) => setTimeout(r, 30));
    }
    const views = container.querySelectorAll(".related-view");
    expect(views.length).toBe(2);

    // Top layer loads real images; the covered layer is placeholders.
    await waitFor(() =>
      expect(
        views[1].querySelector("img")?.getAttribute("src")
      ).toContain("/api/img")
    );
    expect(views[0].querySelector("img")?.getAttribute("src")).toContain(
      "data:image/gif"
    );

    // Back: the previously covered layer is top again — images restore.
    await fireEvent.click(views[1].querySelector(".related-back")!);
    await waitFor(() =>
      expect(container.querySelectorAll(".related-view").length).toBe(1)
    );
    await waitFor(() =>
      expect(
        container.querySelector(".related-view img")?.getAttribute("src")
      ).toContain("/api/img")
    );
  });

  it("back from a related view restores the main feed", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    const firstCard = container.querySelector(".feed-card")!;
    await fireEvent.click(firstCard.querySelector(".card-overlay")!);
    await waitFor(() =>
      expect(container.querySelector(".related-view")).toBeTruthy()
    );

    await fireEvent.click(container.querySelector(".related-back")!);
    await waitFor(() =>
      expect(container.querySelector(".related-view")).toBeNull()
    );
    expect(container.querySelectorAll(".feed-card").length).toBe(30);
  });

  it("refuses to open a stack for a work already in the stack", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Open a stack on the first card (id 1).
    const firstCard = container.querySelector(".feed-card")!;
    await fireEvent.click(firstCard.querySelector(".card-overlay")!);
    await waitFor(() =>
      expect(container.querySelectorAll(".related-view").length).toBe(1)
    );

    // Tap the ANCHOR (same work) inside the stack — must not push again.
    const anchorCard = container.querySelector(".related-view .feed-card")!;
    await fireEvent.click(anchorCard.querySelector(".card-overlay")!);
    await waitFor(() =>
      expect(container.querySelector(".toast")?.textContent).toContain(
        "already open"
      )
    );
    expect(container.querySelectorAll(".related-view").length).toBe(1);
  });

  it("close-all returns to the feed from any depth", async () => {
    let level = 0;
    mockedApi.getRelated.mockImplementation(async () =>
      makeFeedOf(8, 900 + level++ * 100)
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Push two levels (tap a related work, never the anchor).
    for (let i = 0; i < 2; i++) {
      const topCard = container.querySelector(".related-view")
        ? container.querySelectorAll(".related-view:last-of-type .feed-card")[1]
        : container.querySelectorAll(".feed-card")[0];
      await fireEvent.click(topCard.querySelector(".card-overlay")!);
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(container.querySelectorAll(".related-view").length).toBe(2);

    await fireEvent.click(container.querySelector(".close-all-btn")!);
    await waitFor(() =>
      expect(container.querySelectorAll(".related-view").length).toBe(0)
    );
    expect(container.querySelectorAll(".feed-card").length).toBe(30);
  });

  it("artist tap opens the artist library", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    await fireEvent.click(container.querySelector(".feed-card .card-artist a")!);
    await waitFor(() =>
      expect(container.querySelector(".artist-view")).toBeTruthy()
    );
    expect(mockedApi.getUserIllusts).toHaveBeenCalledWith(101); // first mock artist id
    await waitFor(() =>
      expect(
        container.querySelectorAll(".artist-view .feed-card").length
      ).toBe(6)
    );
  });

  it("settings live in the drawer; adding a blocked tag filters the feed on reload", async () => {
    // Street feed: one work tagged swimsuit.
    mockedApi.getStreet.mockResolvedValue(
      makeFeed([
        ...makeFeedOf(29, 1).illusts.map((i) => ({ ...i, tags: [] })),
        makeIllust({ id: 999, tags: [{ name: "swimsuit" }] }),
      ])
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Open settings from the drawer.
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(
      [...container.querySelectorAll(".drawer-item")].find(
        (b) => b.textContent?.includes("Settings")
      )!
    );
    await waitFor(() =>
      expect(container.querySelector(".modal-dialog")).toBeTruthy()
    );
    const input = container.querySelector(".blocked-tag-form input")!;
    await fireEvent.input(input, { target: { value: "swimsuit" } });
    await fireEvent.submit(container.querySelector(".blocked-tag-form")!);
    expect(container.querySelector(".blocked-tag-pill")?.textContent).toBe(
      "#swimsuit"
    );

    // Switch to Ranking and back to Home — fresh street load,
    // swimsuit work filtered out.
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(
      [...container.querySelectorAll(".drawer-item")].find(
        (b) => b.textContent === "Ranking"
      )!
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(
      [...container.querySelectorAll(".drawer-item")].find(
        (b) => b.textContent === "Home"
      )!
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(29)
    );
  });

  describe("z-index desync regressions (black-screen class)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // Suppressed cards swap their src to a 1px GIF placeholder; alive
    // cards point at the image proxy. This is the black screen signal.
    const artistImgSrc = (c: HTMLElement) =>
      c.querySelector(".artist-view img")?.getAttribute("src") ?? "";

    async function openTwoDeepStack(container: HTMLElement) {
      await fireEvent.click(
        container.querySelector(".feed-card .card-overlay")!
      );
      await waitFor(() =>
        expect(container.querySelectorAll(".related-view").length).toBe(1)
      );
      await fireEvent.click(
        container
          .querySelectorAll(".related-view:last-of-type .feed-card")[1]
          .querySelector(".card-overlay")!
      );
      await waitFor(() =>
        expect(container.querySelectorAll(".related-view").length).toBe(2)
      );
    }

    it("popping a stack level under an open artist keeps the artist's images alive", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(30)
      );
      await openTwoDeepStack(container);

      // Artist page on top of both stack levels.
      await fireEvent.click(
        container.querySelector(".related-view:last-of-type .card-artist a")!
      );
      await waitFor(() =>
        expect(container.querySelector(".artist-view")).toBeTruthy()
      );
      vi.advanceTimersByTime(700); // flush image activation timers
      expect(artistImgSrc(container)).toContain("/api/img");

      // Pop the top stack level. The artist stays above the remaining
      // stack — the old close path pointed topZ at that stack, marking
      // the artist "obscured" and unloading every image (black screen).
      await fireEvent.click(
        container
          .querySelectorAll(".related-view")[1]
          .querySelector(".related-back")!
      );
      vi.advanceTimersByTime(260); // slide-out window elapses
      await vi.runAllTicks();
      expect(container.querySelectorAll(".related-view").length).toBe(1);
      expect(artistImgSrc(container)).toContain("/api/img");
    });

    it("an artist opened during a stack's slide-out stays on top with images alive", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(30)
      );
      await openTwoDeepStack(container);

      // Start popping the top level (260ms slide-out timer pending)…
      await fireEvent.click(
        container
          .querySelectorAll(".related-view")[1]
          .querySelector(".related-back")!
      );
      // …and, mid-animation, tap an artist name in the stack beneath.
      await fireEvent.click(
        container.querySelector(".related-view .card-artist a")!
      );
      await waitFor(() =>
        expect(container.querySelector(".artist-view")).toBeTruthy()
      );

      // The stale pop timeout must NOT demote the artist to below the
      // remaining stack (old code: topZ pointed at the stack).
      vi.advanceTimersByTime(260);
      await vi.runAllTicks();
      expect(container.querySelectorAll(".related-view").length).toBe(1);
      vi.advanceTimersByTime(700);
      expect(artistImgSrc(container)).toContain("/api/img");
    });

    it("close-all over an artist lands back on the artist page with images alive", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(30)
      );

      await fireEvent.click(
        container.querySelector(".feed-card .card-overlay")!
      );
      await waitFor(() =>
        expect(container.querySelectorAll(".related-view").length).toBe(1)
      );
      await fireEvent.click(
        container.querySelector(".related-view .card-artist a")!
      );
      await waitFor(() =>
        expect(container.querySelector(".artist-view")).toBeTruthy()
      );
      vi.advanceTimersByTime(700);
      expect(artistImgSrc(container)).toContain("/api/img");

      // Push a stack from inside the artist page.
      await fireEvent.click(
        container.querySelector(".artist-view .feed-card .card-overlay")!
      );
      await waitFor(() =>
        expect(container.querySelectorAll(".related-view").length).toBe(2)
      );

      // Close-all from the stack.
      await fireEvent.click(container.querySelector(".close-all-btn")!);
      await vi.runAllTicks();
      expect(container.querySelectorAll(".related-view").length).toBe(0);
      expect(container.querySelector(".artist-view")).toBeTruthy();
      vi.advanceTimersByTime(700); // re-activation after un-obscuring
      expect(artistImgSrc(container)).toContain("/api/img");

      // The snapshot must keep the artist page (old code persisted
      // artist:null — a reload would silently drop the layer beneath).
      const snap = JSON.parse(
        localStorage.getItem("pixtok_state_v2") ?? "{}"
      );
      expect(snap.artist).not.toBeNull();
      expect(snap.layerOrder).toContain("artist");
    });

    it("a new artist opened during the old artist's slide-out survives the stale close timer", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(30)
      );

      // Open artist A from the first feed card.
      await fireEvent.click(
        container.querySelector(".feed-card .card-artist a")!
      );
      await waitFor(() =>
        expect(container.querySelector(".artist-view")).toBeTruthy()
      );
      expect(
        container.querySelector(".artist-name-badge")?.textContent
      ).toContain("Artist 1");

      // Back — slide-out starts, a stale 260ms timer is pending.
      await fireEvent.click(
        container.querySelector(".artist-view .related-back")!
      );

      // Mid-animation, tap a DIFFERENT artist in the feed beneath.
      await fireEvent.click(
        container.querySelectorAll(".feed-card .card-artist a")[1]!
      );
      await waitFor(() =>
        expect(
          container.querySelector(".artist-name-badge")?.textContent
        ).toContain("Artist 2")
      );

      // The stale close timer fires: it must NOT clear the new artist.
      vi.advanceTimersByTime(260);
      await vi.runAllTicks();
      expect(container.querySelector(".artist-view")).toBeTruthy();
      expect(
        container.querySelector(".artist-name-badge")?.textContent
      ).toContain("Artist 2");
    });
  });
});


  describe("grid view mode", () => {
    it("grid toggle renders cells in the main feed; stack layers stay strip", async () => {
      mockedApi.getFeedViewMode.mockResolvedValue({ value: "grid" });
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".grid-cell").length).toBe(30)
      );
      // No strip cards, no text overlays in the main feed.
      expect(container.querySelectorAll(".feed-card")).toHaveLength(0);
      expect(container.querySelector(".card-title")).toBeNull();

      // Tapping a cell pushes a related stack — which ALWAYS renders strip.
      await fireEvent.click(container.querySelector(".grid-cell")!);
      await waitFor(() =>
        expect(container.querySelectorAll(".related-view .feed-card").length).toBeGreaterThan(0)
      );
      expect(mockedApi.getRelated).toHaveBeenCalledWith(1);
    });

    it("seeds the artist-view mode at boot from the server", async () => {
      mockedApi.getArtistViewMode.mockResolvedValue({ value: "grid" });
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(30)
      );
      // Feed still strip; artist page would be grid — assert the seed
      // call was made and the main feed is untouched.
      expect(mockedApi.getArtistViewMode).toHaveBeenCalled();
      expect(mockedApi.getFeedViewMode).toHaveBeenCalled();
      expect(container.querySelectorAll(".grid-cell")).toHaveLength(0);
    });

    it("settings toggle persists the feed view mode via PUT", async () => {
      // store.ts holds the REAL api module (test-setup loads it before
      // the vi.mock hoist) — stub fetch at the network edge to observe
      // the prefs PUT, same technique as store.test.ts.
      const fetchCalls: { url: string; init?: RequestInit }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          fetchCalls.push({ url, init });
          return new Response(JSON.stringify({ value: "grid" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        })
      );

      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(30)
      );

      // Open Settings from the drawer.
      await fireEvent.click(container.querySelector(".burger-pill")!);
      await fireEvent.click(
        [...container.querySelectorAll(".drawer-item")].find(
          (b) => b.textContent?.includes("Settings")
        )!
      );
      await waitFor(() =>
        expect(container.querySelector(".modal-dialog")).toBeTruthy()
      );

      // Feeds row → Grid.
      const feedsRow = container.querySelector(
        '[data-testid="feed-view-row"]'
      )!;
      await fireEvent.click(
        [...feedsRow.querySelectorAll(".mode-pill")].find(
          (b) => b.textContent === "Grid"
        )!
      );

      // The main feed swaps to grid cells immediately.
      await waitFor(() =>
        expect(container.querySelectorAll(".grid-cell").length).toBe(30)
      );
      expect(container.querySelectorAll(".feed-card")).toHaveLength(0);

      // The change is persisted: a PUT with {value:"grid"} hit the prefs
      // endpoint (queued writes settle across microtasks).
      await vi.waitFor(() => {
        expect(
          fetchCalls.some(
            (c) =>
              c.url === "/api/prefs/feed-view-mode" &&
              c.init?.method === "PUT"
          )
        ).toBe(true);
      });
      vi.unstubAllGlobals();
    });
  });


  describe("pagination failure (429 storm regression)", () => {
    it("a failed page load stops auto-pagination; the retry button recovers", async () => {
      // jsdom's IO mock reports the sentinel intersecting immediately,
      // so with a next_url the continuation fires on its own — same
      // geometry as the grid-mode bug on a real phone.
      mockedApi.getStreet
        .mockResolvedValueOnce(makeFeedOf(30, 1, "/api/next?cursor=p2"))
        .mockRejectedValueOnce(new Error("429: rate limited"))
        .mockResolvedValueOnce(makeFeedOf(10, 100, null));
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(30)
      );
      await waitFor(() =>
        expect(mockedApi.getStreet).toHaveBeenCalledTimes(2)
      );
      // The failure surfaces the retry button…
      await waitFor(() =>
        expect(
          container.querySelector(".feed-sentinel .mode-pill")?.textContent
        ).toContain("Couldn't load")
      );
      // …and MUST NOT auto-retry: after a long settle, still exactly 2.
      await new Promise((r) => setTimeout(r, 400));
      expect(mockedApi.getStreet).toHaveBeenCalledTimes(2);

      // The retry button recovers.
      await fireEvent.click(
        container.querySelector(".feed-sentinel .mode-pill")!
      );
      await waitFor(() =>
        expect(mockedApi.getStreet).toHaveBeenCalledTimes(3)
      );
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(40)
      );
    });

    it("a feed switch clears a stale load error so pagination can resume", async () => {
      // Call order: #1 boot page, #2 continuation (fails), #3 fresh Home
      // page after the feed switch, #4 its continuation (must fire —
      // proving the stale loadError was cleared and canLoad is true
      // again). The chain ENDS on a null next_url or jsdom's
      // always-intersecting sentinel paginates forever by construction.
      mockedApi.getStreet
        .mockResolvedValueOnce(makeFeedOf(30, 1, "/api/next?cursor=p2"))
        .mockRejectedValueOnce(new Error("429: rate limited"))
        .mockResolvedValueOnce(makeFeedOf(30, 1, "/api/next?cursor=p2"))
        .mockResolvedValueOnce(makeFeedOf(10, 100, null));
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(mockedApi.getStreet).toHaveBeenCalledTimes(2)
      );
      await waitFor(() =>
        expect(
          container.querySelector(".feed-sentinel .mode-pill")?.textContent
        ).toContain("Couldn't load")
      );

      // Switch to Ranking and back to Home: the fresh Home load must be
      // able to paginate (loadError reset by the feed switch).
      await fireEvent.click(container.querySelector(".burger-pill")!);
      await fireEvent.click(
        [...container.querySelectorAll(".drawer-item")].find(
          (b) => b.textContent === "Ranking"
        )!
      );
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(30)
      );
      await fireEvent.click(container.querySelector(".burger-pill")!);
      await fireEvent.click(
        [...container.querySelectorAll(".drawer-item")].find(
          (b) => b.textContent === "Home"
        )!
      );
      // Home auto-paginates again (30 + 10) — the error guard cleared.
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(40)
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(mockedApi.getStreet).toHaveBeenCalledTimes(4);
    });
  });
