import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { http, HttpResponse } from "msw";
import App from "./App";

/** Topmost related view's cards — robust against animation-timing
 * DOM states that make :last-of-type unreliable in tests. */
function topRelatedCards(container: HTMLElement) {
  const views = container.querySelectorAll(".related-view");
  if (views.length === 0) return [];
  return Array.from(views[views.length - 1].querySelectorAll(".feed-card"));
}

import { makeFeedOf, makeFeed, makeIllust } from "./test-fixtures";

/**
 * App orchestration: boot, the gate, feed/mode switching, snapshot
 * rehydration and the layer machine.
 *
 * Network: the REAL api/*.ts modules run against the shared MSW fixture
 * (src/test/msw) — every call goes through request() → fetch() and is
 * answered at the HTTP boundary, like production. Per-test variations
 * use server.use(...) (reset after each test) instead of vi.mock module
 * factories. Feed fixtures keep the old mock defaults' id ranges
 * (street 1.., top 1000.., recommended/workRecs 500.., related 900..,
 * bookmarks 4000..), so a cross-feed bleed still shows up in counts.
 *
 * Why api/client is STILL partially mocked: setOnGateLocked /
 * setOnRequestError are the app↔transport registration API. The specs
 * below pin the SUBSCRIPTION wiring ("exactly one listener registered
 * on mount") and then invoke the captured callback directly to simulate
 * a mid-session 403 / transport failure — neither is observable at the
 * HTTP boundary, so server.use() cannot express it. Everything else in
 * the module (request, ApiError, reportApiError, logEvent) stays REAL:
 * a failed fetch now reaches the app's real error path.
 */
vi.mock("./api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api/client")>();
  return {
    ...actual,
    setOnGateLocked: vi.fn(),
    setOnRequestError: vi.fn(),
  };
});

import { setOnGateLocked, setOnRequestError } from "./api/client";
import { json } from "./test/msw/handlers";
import {
  requestCount,
  requestParams,
  requestsTo,
  server,
} from "./test/msw/server";

/**
 * Pump microtasks WITHOUT advancing fake timers — the fake-timer-safe
 * waitFor. MSW resolves its request pipeline (match → headers → body
 * stream) over microtasks, so this waits for data without touching the
 * fake clock (same helper shape as UgoiraPlayer.test.tsx).
 */
async function pumpUntil(check: () => boolean, label: string, max = 5000) {
  for (let i = 0; i < max; i++) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error(
    `pumpUntil: "${label}" never became true within ${max} microtask turns`
  );
}

/** Query-param values carried by that path's requests, in arrival order. */
function paramsOf(path: string): Record<string, string>[] {
  return requestParams(path);
}

/**
 * Resolve once MSW has ANSWERED a matching request. MSW's hop costs real
 * milliseconds (unlike a module mock's microtask), so two orderings
 * matter: a boot seed may land after the test's first interaction (and
 * re-seed the store), and a write may still be in flight when afterEach
 * resets the shared fixture. Register BEFORE the action, await after.
 */
function nextMockedResponse(
  match: (request: Request) => boolean
): Promise<void> {
  return new Promise((resolve) => {
    const listener = ({
      request,
    }: {
      request: Request;
      response: Response;
      requestId: string;
    }) => {
      if (!match(request)) return;
      server.events.removeListener("response:mocked", listener);
      resolve();
    };
    server.events.on("response:mocked", listener);
  });
}

beforeEach(() => {
  // Session snapshots must not leak between tests (a leftover
  // pixtok_state_v2 would make later renders rehydrate instead of
  // loading the street feed).
  localStorage.clear();
  // The gate-lock / error listeners are registered per-mount; a stale
  // handler bound to an unmounted component's signal would silently
  // no-op between tests.
  vi.mocked(setOnGateLocked).mockReset();
  vi.mocked(setOnRequestError).mockReset();
});

afterEach(() => vi.unstubAllGlobals());

/**
 * IntersectionObserver whose delivery the test drives, so "was the CURRENT
 * sentinel re-observed after the UI remounted?" is observable. Entries are
 * only delivered for targets still in the document: a detached sentinel is
 * exactly what a stale observer would be left watching.
 */
class ControlledIO {
  static instances: ControlledIO[] = [];
  private targets = new Set<Element>();
  private cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    ControlledIO.instances.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  static isObserved(el: Element | null): boolean {
    return !!el && ControlledIO.instances.some((io) => io.targets.has(el));
  }
  static fireSentinel() {
    for (const io of ControlledIO.instances) {
      for (const el of io.targets) {
        // Only the scroll sentinel: card observers need geometry this
        // mock does not model, and delivering to them proves nothing.
        if (!el.isConnected || !el.classList.contains("feed-sentinel")) continue;
        io.cb(
          [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
          io as unknown as IntersectionObserver
        );
      }
    }
  }
}

describe("App", () => {
  it("loads the street feed on mount", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    // The first-page cursor is the literal "{}" body (feeds.ts) — the
    // wire shape, not just the module call, is the backend contract.
    const street = requestsTo("/api/street");
    expect(street).toHaveLength(1);
    expect(await street[0].bodyText()).toBe("{}");
  });

  it("restores the saved tab and layers but always loads the feed fresh", async () => {
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "recommended",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        stack: [],
        artist: null,
        recs: [],
        recsSource: "",
        modalOpen: false,
      })
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(5)
    );
    // Feeds always load fresh on boot (user decision): the saved TAB
    // survives, saved feed content does not exist to restore.
    expect(requestCount("/api/street")).toBe(0);
    expect(requestCount("/api/recommended")).toBeGreaterThan(0);
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
    const street = requestsTo("/api/street");
    expect(street).toHaveLength(1);
    expect(await street[0].bodyText()).toBe("{}");
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
    expect(requestCount("/api/user/777/illusts")).toBeGreaterThan(0);
    // The feed still loads fresh underneath the restored artist layer —
    // layers persist, feeds are always new.
    expect(requestCount("/api/street")).toBeGreaterThan(0);
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

  it("restores the SAVED open order: a stack above the artist stays on top", async () => {
    // layerOrder is the whole point of the saved order. The fallback always
    // puts the artist on top, which flipped artist-under-stack sessions and
    // fed the black-screen class; ["artist","s0"] says the stack opened LAST
    // and must come back on top with live images (the artist suppressed).
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "home",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        stack: makeFeedOf(1, 900).illusts,
        artist: { id: 777, name: "RestoredArtist" },
        recs: [],
        recsSource: "",
        modalOpen: false,
        searchStack: [],
        searchTags: [],
        layerOrder: ["artist", "s0"],
      })
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelector(".related-view")).not.toBeNull()
    );
    await waitFor(() =>
      expect(container.querySelector(".artist-view")).not.toBeNull()
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".artist-view .feed-card").length).toBe(6)
    );

    const rvZ = parseInt(
      (container.querySelector(".related-view") as HTMLElement).style.zIndex,
      10
    );
    const avZ = parseInt(
      (container.querySelector(".artist-view") as HTMLElement).style.zIndex,
      10
    );
    expect(rvZ).toBeGreaterThan(avZ);

    // The stack owns the image windows; the covered artist page does not.
    await waitFor(() =>
      expect(
        container.querySelector(".related-view img")?.getAttribute("src")
      ).toContain("/api/img")
    );
    expect(
      container.querySelector(".artist-view img")?.getAttribute("src")
    ).toContain("data:image/gif");
  });

  it("surfaces request failures in the red top toast; tap dismisses", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    const reg = vi.mocked(setOnRequestError);
    expect(reg).toHaveBeenCalledTimes(1);
    // Simulate a request() failure firing mid-session (the detection
    // itself is pinned in api/client.test.ts and the e2e spec).
    (reg.mock.calls[0][0] as (message: string) => void)("Request failed (502)");
    const toastEl = container.querySelector(".error-toast");
    expect(toastEl).not.toBeNull();
    expect(toastEl!.textContent).toContain("Request failed (502)");
    fireEvent.click(toastEl!);
    expect(container.querySelector(".error-toast")).toBeNull();
  });

  it("re-shows the gate mid-session, then unlocking re-binds the feed sentinel", async () => {
    // A page-1 cursor is REQUIRED for a sentinel to exist at all — the
    // default fixture is a single page (next_url null) and would never
    // observe one.
    server.use(
      http.post("/api/street", async ({ request }) => {
        const raw = (await request.text()).trim();
        return json(
          raw === "" || raw === "{}"
            ? makeFeedOf(30, 1, "/api/next?cursor=p2")
            : makeFeedOf(10, 5000)
        );
      })
    );
    ControlledIO.instances.length = 0;
    vi.stubGlobal("IntersectionObserver", ControlledIO);
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    // The controlled observer never fires on its own → no page 2 yet.
    expect(requestCount("/api/street")).toBe(1);

    const reg = vi.mocked(setOnGateLocked);
    expect(reg).toHaveBeenCalledTimes(1);
    // The live trigger is a 403 "gate locked" inside request() — this
    // simulates that firing mid-session (unit-testable wiring; the 403
    // detection itself is pinned in api/client.test.ts and the e2e spec).
    (reg.mock.calls[0][0] as () => void)();
    expect(container.querySelector(".gate-screen")).not.toBeNull();
    expect(container.querySelectorAll(".feed-card").length).toBe(0);

    // Unlock (the gate's onUnlocked path) → the app UI remounts. Its
    // sentinel must be RE-BOUND to the new DOM node, or infinite scroll
    // stays dead for the rest of the session.
    const input = container.querySelector(".gate-form input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "letmein" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(container.querySelector(".gate-screen")).toBeNull()
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    // Unlock resumes the existing session: no second page-1 fetch.
    expect(requestCount("/api/street")).toBe(1);
    // The remounted sentinel must be observed by a LIVE observer.
    expect(
      ControlledIO.isObserved(container.querySelector(".feed-sentinel"))
    ).toBe(true);

    ControlledIO.fireSentinel();
    await waitFor(() => expect(requestCount("/api/street")).toBe(2));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(40)
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
    await waitFor(() =>
      expect(requestCount("/api/search/artworks")).toBe(1)
    );
    // The typed word rides the query string; a dropped/renamed param
    // would search something else entirely.
    expect(paramsOf("/api/search/artworks")[0]).toMatchObject({
      word: "fantasy",
    });
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
    expect(requestCount("/api/search/artworks")).toBe(0);
  });

  it("boots past a malformed restored search layer instead of re-locking the gate", async () => {
    // A v1 snapshot whose search arrays carry junk (null works, a user with
    // no previews, primitive popular/related entries). The old loader
    // validated only the array containers, so SearchScreen threw during
    // boot — the gate-status catch re-locked the screen as
    // gate:unreachable, and every reload repeated it. The layer must
    // restore sanitized (empty results) and refetch on mount.
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "home",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        stack: [],
        artist: null,
        recs: [],
        recsSource: "",
        modalOpen: false,
        searchStack: [
          {
            word: "fantasy",
            mode: "works",
            order: "date_d",
            contentMode: "all",
            workType: "all",
            sMode: "s_tag_full",
            aiType: "0",
            dateMode: "all",
            scd: "",
            sce: "",
            works: [null, 42],
            popular: [{}],
            related: [null],
            users: [{ id: 5, name: "NoPreviews" }],
            page: 1,
            hasMore: false,
          },
        ],
        searchTags: [null],
        layerOrder: ["search0"],
      })
    );
    const { container } = render(() => <App />);
    // The app booted: feed requested, no gate screen.
    await waitFor(() =>
      expect(requestCount("/api/street")).toBeGreaterThan(0)
    );
    expect(container.querySelector(".gate-screen")).toBeNull();
    await waitFor(() =>
      expect(container.querySelector(".search-screen")).not.toBeNull()
    );
    expect(
      (container.querySelector(".search-input") as HTMLInputElement).value
    ).toBe("fantasy");
    // Empty restored results -> exactly one mount refetch.
    await waitFor(() => expect(requestCount("/api/search/artworks")).toBe(1));
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
    expect(requestCount("/api/bookmarks")).toBeGreaterThan(0);
    // The backend 400s a bookmarks page without an offset — the wire
    // must carry offset=0 on the first load.
    expect(paramsOf("/api/bookmarks")[0]).toMatchObject({ offset: "0" });
  });

  it("restores the private bookmarks pile from the snapshot", async () => {
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "bookmarks",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        bookmarkVis: "private",
        bookmarkTag: "",
        stack: [],
        artist: null,
        recs: [],
        recsSource: "",
        modalOpen: false,
      })
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(6)
    );
    // Private pile = the app-API feed, not the public web page.
    expect(requestCount("/api/bookmarks/private")).toBeGreaterThan(0);
    expect(requestCount("/api/bookmarks")).toBe(0);
    const active = container.querySelector(".mode-pill.active");
    expect(active?.textContent).toBe("Private");
  });

  it("restores the bookmark tag filter from the snapshot", async () => {
    server.use(
      http.get("/api/bookmarks/tags", () =>
        json({ public: [{ name: "tag-one", count: 3 }], private: [] })
      )
    );
    localStorage.setItem(
      "pixtok_state_v2",
      JSON.stringify({
        v: 1,
        feedType: "bookmarks",
        rankContent: "all",
        rankMode: "day",
        newestR18: false,
        topMode: "all",
        bookmarkVis: "public",
        bookmarkTag: "tag-one",
        stack: [],
        artist: null,
        recs: [],
        recsSource: "",
        modalOpen: false,
      })
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(requestCount("/api/bookmarks")).toBeGreaterThan(0)
    );
    // The first page load already carries the restored folder.
    expect(paramsOf("/api/bookmarks")[0]).toMatchObject({
      tag: "tag-one",
      offset: "0",
    });
    await waitFor(() =>
      expect(
        [...container.querySelectorAll(".mode-pill")].find(
          (b) => b.textContent === "tag-one"
        )?.className
      ).toContain("active")
    );
  });

  it("persists the bookmarks visibility pill in the snapshot", async () => {
    const { getByText, container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Bookmarks"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(8)
    );
    await fireEvent.click(
      [...container.querySelectorAll(".mode-pill")].find(
        (b) => b.textContent === "Private"
      )!
    );
    await waitFor(() => expect(requestCount("/api/bookmarks/private")).toBe(1));
    await new Promise((r) => setTimeout(r, 650)); // snapshot debounce
    const snap = JSON.parse(localStorage.getItem("pixtok_state_v2")!);
    expect(snap.bookmarkVis).toBe("private");
  });

  it("locks behind the gate and boots after unlocking", async () => {
    server.use(http.get("/api/gate/status", () => json({ locked: true })));
    const { container } = render(() => <App />);

    // Gate up, nothing boots.
    await waitFor(() =>
      expect(container.querySelector(".gate-screen")).not.toBeNull()
    );
    expect(requestCount("/api/street")).toBe(0);

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
    const unlock = requestsTo("/api/gate");
    expect(unlock).toHaveLength(1);
    expect(await unlock[0].json()).toEqual({ password: "letmein" });
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
    // Feed content is deliberately not persisted — feeds are always new.
    expect(saved.illusts).toBeUndefined();
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
    expect(paramsOf("/api/top").map((p) => p.mode)).toContain("day");
  });

  it("switching to R18 on the Ranking tab refetches with mode=day_r18", async () => {
    server.use(
      http.get("/api/top", ({ request }) => {
        const mode = new URL(request.url).searchParams.get("mode");
        return json(
          mode === "day_r18" ? makeFeedOf(12, 9000) : makeFeedOf(30, 1)
        );
      })
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
    expect(paramsOf("/api/top").map((p) => p.mode)).toContain("day_r18");
  });

  it("switching the ranking mode pill refetches with the new mode", async () => {
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
    expect(paramsOf("/api/top").map((p) => p.mode)).toContain("week");
  });

  it("switching to Discover loads the recommended feed", async () => {
    server.use(
      http.get("/api/recommended", () => json(makeFeedOf(9, 700)))
    );
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
    expect(requestCount("/api/recommended")).toBeGreaterThan(0);
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
    expect(requestCount("/api/auth/status")).toBeGreaterThan(0);
    await waitFor(() =>
      // Connected banner + two green surface rows when fully authed.
      expect(container.querySelectorAll(".auth-status.ok").length).toBe(3)
    );
  });

  it("shows the retry button and recovers after a failed first load", async () => {
    // First street page fails, the retry succeeds with a shorter feed.
    let streetCalls = 0;
    server.use(
      http.post("/api/street", () => {
        streetCalls++;
        return streetCalls === 1
          ? new HttpResponse("boom\n", { status: 500 })
          : json(makeFeedOf(5, 1));
      })
    );
    const { getByText, container } = render(() => <App />);

    await waitFor(() => expect(getByText("Retry")).toBeTruthy());
    await fireEvent.click(getByText("Retry"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(5)
    );
  });

  it("discards an in-flight street load when the user switches tabs", async () => {
    // The street response is held open until after the tab switch.
    let releaseStreet!: (response: Response) => void;
    server.use(
      http.post(
        "/api/street",
        () =>
          new Promise<Response>((resolve) => {
            releaseStreet = resolve;
          })
      )
    );
    const { container, getByText } = render(() => <App />);
    await waitFor(() => expect(requestCount("/api/street")).toBe(1));

    // Switch to Discover while the street load is still pending.
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Discover"));
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(5)
    );

    // The stale street response arrives AFTER the switch — discarded.
    releaseStreet(json(makeFeedOf(30, 1)));
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelectorAll(".feed-card").length).toBe(5);
    // No continuation was requested off the abandoned load.
    expect(requestCount("/api/street")).toBe(1);
  });

  it("no toast when the liked work has no recommendations", async () => {
    server.use(
      http.get("/api/illust/:id/recs", () => json(makeFeedOf(0, 0)))
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    await fireEvent.click(container.querySelector(".like-btn")!);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".toast")).toBeNull();
  });

  it("shows an error toast when recommendations fail to load", async () => {
    server.use(
      http.get(
        "/api/illust/:id/recs",
        () => new HttpResponse("upstream error\n", { status: 502 })
      )
    );
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
    server.use(
      http.get("/api/illust/:id/related", () =>
        json(makeFeedOf(8, 900 + level++ * 100))
      )
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Push 10 levels (the max) — tap a related work, never the anchor.
    for (let i = 0; i < 10; i++) {
      const topCard = container.querySelector(".related-view")
        ? topRelatedCards(container)[1]
        : container.querySelectorAll(".feed-card")[0];
      await fireEvent.click(topCard.querySelector(".card-overlay")!);
      await waitFor(() =>
        expect(container.querySelectorAll(".related-view").length).toBe(i + 1)
      );
      // The new level's related works must land before the next tap —
      // the overlay we tap lives on card #1 of that page.
      await waitFor(() =>
        expect(topRelatedCards(container).length).toBeGreaterThanOrEqual(2)
      );
    }
    expect(container.querySelectorAll(".related-view").length).toBe(10);

    // The 11th tap must not silently vanish — a toast explains the cap.
    const topCard = topRelatedCards(container)[1];
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
    // Per-work recommendations for the liked card. (getWorkRecs also
    // hands the request an AbortSignal so a newer like supersedes an
    // older fetch; that is internal to the api module and has no wire
    // representation — the id in the path is the observable contract.)
    expect(requestsTo("/api/illust/1/recs")).toHaveLength(1);

    await fireEvent.click(container.querySelector(".toast")!);
    await waitFor(() =>
      expect(container.querySelector(".recs-modal")).toBeTruthy()
    );
    expect(
      container.querySelectorAll(".recs-modal .feed-card").length
    ).toBe(5); // shared fixture returns 5 recs
  });

  it("tapping a card pushes a related view anchored on that card", async () => {
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    const firstCard = container.querySelector(".feed-card")!;
    await fireEvent.click(firstCard.querySelector(".card-overlay")!);

    await waitFor(() =>
      expect(container.querySelector(".related-view")).toBeTruthy()
    );
    await waitFor(() =>
      expect(
        container.querySelectorAll(".related-view .feed-card").length
      ).toBe(9) // anchor + 8 related
    );

    // The anchor id is the wire contract, and the handler echoes it into
    // the batch: a hardcoded/stack[0] anchor would request a different id
    // AND render a different set of titles.
    expect(requestsTo("/api/illust/1/related")).toHaveLength(1);
    const titles = [
      ...container.querySelectorAll(".related-view .card-title"),
    ].map((t) => t.textContent);
    expect(titles).toEqual([
      "Illust 1", // the tapped card is the stack's anchor
      ...Array.from({ length: 8 }, (_, i) => `Illust ${901 + i}`),
    ]);
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
    server.use(
      http.get("/api/illust/:id/related", () =>
        json(makeFeedOf(8, 900 + level++ * 100))
      )
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Push two levels.
    for (let i = 0; i < 2; i++) {
      const topCard = container.querySelector(".related-view")
        ? topRelatedCards(container)[1]
        : container.querySelectorAll(".feed-card")[0];
      await fireEvent.click(topCard.querySelector(".card-overlay")!);
      await waitFor(() =>
        expect(container.querySelectorAll(".related-view").length).toBe(i + 1)
      );
      await waitFor(() =>
        expect(topRelatedCards(container).length).toBeGreaterThanOrEqual(2)
      );
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
    server.use(
      http.get("/api/illust/:id/related", () =>
        json(makeFeedOf(8, 900 + level++ * 100))
      )
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Push two levels (tap a related work, never the anchor).
    for (let i = 0; i < 2; i++) {
      const topCard = container.querySelector(".related-view")
        ? topRelatedCards(container)[1]
        : container.querySelectorAll(".feed-card")[0];
      await fireEvent.click(topCard.querySelector(".card-overlay")!);
      await waitFor(() =>
        expect(container.querySelectorAll(".related-view").length).toBe(i + 1)
      );
      await waitFor(() =>
        expect(topRelatedCards(container).length).toBeGreaterThanOrEqual(2)
      );
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
    expect(requestCount("/api/user/101/illusts")).toBeGreaterThan(0); // first feed artist id
    await waitFor(() =>
      expect(
        container.querySelectorAll(".artist-view .feed-card").length
      ).toBe(6)
    );
  });

  it("adding a blocked tag while the boot seed is in flight survives the seed", async () => {
    // Street feed: one work tagged swimsuit.
    server.use(
      http.post("/api/street", () =>
        json(
          makeFeed([
            ...makeFeedOf(29, 1).illusts.map((i) => ({ ...i, tags: [] })),
            makeIllust({ id: 999, tags: [{ name: "swimsuit" }] }),
          ])
        )
      ),
      // Hold the boot seed open so the user edits the list WHILE it is in
      // flight. A seed arriving later used to REPLACE the working list with
      // the server's pre-edit snapshot: the pill vanished and the feed
      // reloaded unfiltered (the ghost revert). It must merge.
      http.get(
        "/api/prefs/blocked-tags",
        () =>
          new Promise<Response>((resolve) => {
            releaseSeed = resolve;
          })
      )
    );
    let releaseSeed!: (r: Response) => void;
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    // Open settings from the drawer and add the tag while the seed is
    // still in flight.
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

    // The seed lands last, carrying the server's pre-edit list — it must
    // not clobber the edit.
    releaseSeed(json({ tags: [] }));
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector(".blocked-tag-pill")?.textContent).toBe(
      "#swimsuit"
    );

    // Switch to Ranking and back to Home — fresh street load, swimsuit
    // work filtered out.
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

  it("a boot tag seed filters the page already on screen", async () => {
    // The seed arrives after the first street page rendered. The blocked
    // work must disappear without waiting for the next feed load — the
    // seed's own tags never re-filtered an already-rendered page.
    server.use(
      http.post("/api/street", () =>
        json(
          makeFeed([
            ...makeFeedOf(29, 1).illusts.map((i) => ({ ...i, tags: [] })),
            makeIllust({ id: 999, tags: [{ name: "swimsuit" }] }),
          ])
        )
      ),
      http.get(
        "/api/prefs/blocked-tags",
        () =>
          new Promise<Response>((resolve) => {
            releaseSeed = resolve;
          })
      )
    );
    let releaseSeed!: (r: Response) => void;
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );

    releaseSeed(json({ tags: ["swimsuit"] }));
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
      // The second level's related page must land before we can tap a
      // work on it (fake timers: pump microtasks, never the clock).
      await pumpUntil(
        () => topRelatedCards(container).length >= 2,
        "first related page"
      );
      await fireEvent.click(
        topRelatedCards(container)[1].querySelector(".card-overlay")!
      );
      await waitFor(() =>
        expect(container.querySelectorAll(".related-view").length).toBe(2)
      );
      await pumpUntil(
        () => topRelatedCards(container).length >= 2,
        "second related page"
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
        (topRelatedCards(container)[0]?.querySelector(".card-artist a") as HTMLElement)!
      );
      await waitFor(() =>
        expect(container.querySelector(".artist-view")).toBeTruthy()
      );
      await pumpUntil(
        () => container.querySelectorAll(".artist-view .feed-card").length === 6,
        "artist works"
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
      await pumpUntil(
        () => container.querySelectorAll(".artist-view .feed-card").length === 6,
        "artist works"
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
      await pumpUntil(
        () => container.querySelectorAll(".artist-view .feed-card").length === 6,
        "artist works"
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


  describe("multi-search layers", () => {
    function tapChip(container: HTMLElement, name: string) {
      const chip = [...container.querySelectorAll(".card-tag-chip")].find((c) =>
        c.textContent?.includes(name)
      ) as HTMLElement;
      expect(chip).toBeTruthy();
      return fireEvent.click(chip);
    }

    it("tag taps stack search pages instead of re-seeding one layer", async () => {
      server.use(
        http.post("/api/street", () =>
          json(
            makeFeed([
              makeIllust({ id: 1, tags: [{ name: "snow" }] }),
              makeIllust({ id: 2, tags: [{ name: "rain" }] }),
            ])
          )
        )
      );
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBeGreaterThan(0)
      );
      await tapChip(container, "snow");
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(1)
      );
      await tapChip(container, "rain");
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(2)
      );
      // Both layers fetched their own tag page.
      await waitFor(() =>
        expect(requestCount("/api/search/artworks")).toBe(2)
      );
      // The covered layer's images are suppressed (top layer owns them).
      const views = container.querySelectorAll(".search-screen");
      await waitFor(() =>
        expect(views[0].querySelector("img")).toBeTruthy()
      );
      expect(views[0].querySelector("img")?.getAttribute("src")).toContain(
        "data:image/gif"
      );
    });

    it("tapping a tag already open toasts instead of stacking a duplicate", async () => {
      server.use(
        http.post("/api/street", () =>
          json(
            makeFeed([makeIllust({ id: 1, tags: [{ name: "snow" }] })])
          )
        )
      );
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBeGreaterThan(0)
      );
      await tapChip(container, "snow");
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(1)
      );
      await tapChip(container, "snow");
      await waitFor(() =>
        expect(container.querySelector(".toast")?.textContent).toContain(
          "already open"
        )
      );
      expect(container.querySelectorAll(".search-screen").length).toBe(1);
      // The duplicate tap issued no second search.
      expect(requestCount("/api/search/artworks")).toBe(1);
    });

    it("back on the top search layer reveals the layer beneath", async () => {
      server.use(
        http.post("/api/street", () =>
          json(
            makeFeed([
              makeIllust({ id: 1, tags: [{ name: "snow" }] }),
              makeIllust({ id: 2, tags: [{ name: "rain" }] }),
            ])
          )
        )
      );
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBeGreaterThan(0)
      );
      await tapChip(container, "snow");
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(1)
      );
      await tapChip(container, "rain");
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(2)
      );
      // Close the top layer (its back button) — the #snow page remains.
      const top = container.querySelectorAll(".search-screen")[1];
      await fireEvent.click(top.querySelector(".related-back")!);
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(1)
      );
      const input = container.querySelector(
        ".search-screen .search-input"
      ) as HTMLInputElement;
      expect(input.value).toBe("snow");
    });

    it("a covered search layer unloads its popular strip", async () => {
      server.use(
        http.post("/api/street", () =>
          json(
            makeFeed([
              makeIllust({ id: 1, tags: [{ name: "snow" }] }),
              makeIllust({ id: 2, tags: [{ name: "rain" }] }),
            ])
          )
        ),
        http.get("/api/search/artworks", () =>
          json({
            illusts: makeFeedOf(3, 2000).illusts,
            total: 3,
            last_page: 1,
            page: 1,
            next_url: null,
            popular: makeFeedOf(2, 3000).illusts,
            related_tags: [],
          })
        )
      );
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBeGreaterThan(0)
      );
      await tapChip(container, "snow");
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(1)
      );
      // The top layer's strip loads through the proxy.
      await waitFor(() =>
        expect(
          container.querySelector(".search-popular-item img")?.getAttribute("src")
        ).toContain("/api/img")
      );

      // Cover it with another tag page: the covered layer's strip must drop
      // to the placeholder (it used to stay fully decoded underneath).
      await tapChip(container, "rain");
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(2)
      );
      const covered = container.querySelectorAll(".search-screen")[0];
      await waitFor(() =>
        expect(
          covered.querySelector(".search-popular-item img")?.getAttribute("src")
        ).toContain("data:image/gif")
      );
    });

    it("a search layer covered by an artist page unloads avatars and previews", async () => {
      server.use(
        http.get("/api/search/users", () =>
          json({
            users: [
              {
                id: 77,
                name: "User One",
                avatar: "https://i.pximg.net/user-profile/img/1.jpg",
                premium: false,
                is_followed: false,
                previews: makeFeedOf(3, 6000).illusts,
              },
            ],
            total: 1,
            page: 1,
            next_url: null,
          })
        )
      );
      const { container, getByText } = render(() => <App />);
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
      await fireEvent.click(getByText("Artists"));
      await waitFor(() =>
        expect(container.querySelector(".search-user-row")).not.toBeNull()
      );
      const avatar = () =>
        container.querySelector(".search-user-avatar")!.getAttribute("src");
      await waitFor(() => expect(avatar()).toContain("/api/img"));

      // Artist page on top → the search layer is covered; its avatar and
      // previews must release their bitmaps.
      await fireEvent.click(container.querySelector(".search-user-main")!);
      await waitFor(() =>
        expect(container.querySelector(".artist-view")).not.toBeNull()
      );
      await waitFor(() => expect(avatar()).toContain("data:image/gif"));
      expect(
        container.querySelector(".search-user-preview img")?.getAttribute("src")
      ).toContain("data:image/gif");
    });

    it("persists the committed search query, not an unsubmitted draft", async () => {
      const { container, getByText } = render(() => <App />);
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
      await waitFor(() =>
        expect(
          container.querySelectorAll(".search-screen .feed-card").length
        ).toBe(3)
      );

      // Abandon a draft afterwards. It used to be reported as the query and
      // persisted: the next boot promoted "draft" while showing fantasy's
      // results, and never refetched.
      await fireEvent.input(input, { target: { value: "draft" } });
      await new Promise((r) => setTimeout(r, 650)); // snapshot debounce
      const snap = JSON.parse(localStorage.getItem("pixtok_state_v2")!);
      expect(snap.searchStack[0].word).toBe("fantasy");
    });

    it("opening a search page during a close animation keeps the new top layer alive", async () => {
      // Regression: opening during the 260ms slide-out used to count the
      // exiting layer when computing the new layer's key index — the
      // key↔array identity desynced, topZ resolved an undefined entry,
      // and the new top layer rendered black (images suppressed). The
      // open must finalize the pending close first.
      server.use(
        http.post("/api/street", () =>
          json(
            makeFeed([
              makeIllust({ id: 1, tags: [{ name: "snow" }] }),
              makeIllust({ id: 2, tags: [{ name: "rain" }] }),
              makeIllust({ id: 3, tags: [{ name: "storm" }] }),
            ])
          )
        )
      );
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBeGreaterThan(0)
      );
      await tapChip(container, "snow");
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(1)
      );
      await tapChip(container, "rain");
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(2)
      );

      // Close the top (#rain) and IMMEDIATELY open #storm — inside the
      // slide-out window, before the 260ms removal timer fires.
      const top = container.querySelectorAll(".search-screen")[1];
      fireEvent.click(top.querySelector(".related-back")!);
      await tapChip(container, "storm");
      await waitFor(() =>
        expect(container.querySelectorAll(".search-screen").length).toBe(2)
      );

      // Long after the close timeout, the TOP layer's images must be
      // live (the /api/img proxy path), not the suppression pixel.
      await waitFor(() =>
        expect(
          container
            .querySelectorAll(".search-screen")[1]
            .querySelectorAll(".feed-card").length
        ).toBe(3)
      );
      await new Promise((r) => setTimeout(r, 400));
      const views = container.querySelectorAll(".search-screen");
      const topImg = views[views.length - 1].querySelector("img");
      expect(topImg?.getAttribute("src")).toContain("/api/img");
    });

    it("caps search pages at MAX_SEARCH_DEPTH with a toast", async () => {
      const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
      server.use(
        http.post("/api/street", () =>
          json(
            makeFeed(
              tags.map((t, i) => makeIllust({ id: i + 1, tags: [{ name: t }] }))
            )
          )
        )
      );
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBeGreaterThan(0)
      );
      for (const t of tags) {
        await tapChip(container, t);
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(container.querySelectorAll(".search-screen").length).toBe(10);
      await waitFor(() =>
        expect(container.querySelector(".toast")?.textContent).toContain(
          "Max search pages"
        )
      );
    });
  });

  describe("grid view mode", () => {
    it("grid toggle renders cells in the main feed; stack layers stay strip", async () => {
      server.use(
        http.get("/api/prefs/feed-view-mode", () => json({ value: "grid" }))
      );
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
      expect(requestCount("/api/illust/1/related")).toBeGreaterThan(0);
    });

    it("seeds the artist-view mode at boot from the server", async () => {
      server.use(
        http.get("/api/prefs/artist-view-mode", () => json({ value: "grid" }))
      );
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(30)
      );
      // Feed still strip; artist page would be grid — assert the seed
      // call was made and the main feed is untouched.
      expect(requestCount("/api/prefs/artist-view-mode")).toBeGreaterThan(0);
      expect(requestCount("/api/prefs/feed-view-mode")).toBeGreaterThan(0);
      expect(container.querySelectorAll(".grid-cell")).toHaveLength(0);
    });

    it("settings toggle persists the feed view mode via PUT", async () => {
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

      // Feeds row → Grid. Register the response waiter first: afterEach
      // resets the shared prefs fixture, so the write must have LANDED
      // (not merely been sent) before this test ends.
      const persisted = nextMockedResponse(
        (r) =>
          r.method === "PUT" &&
          new URL(r.url).pathname === "/api/prefs/feed-view-mode"
      );
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
          requestsTo("/api/prefs/feed-view-mode").some(
            (r) => r.method === "PUT"
          )
        ).toBe(true);
      });
      const put = requestsTo("/api/prefs/feed-view-mode").find(
        (r) => r.method === "PUT"
      )!;
      expect(await put.json()).toEqual({ value: "grid" });
      await persisted;
    });
  });


  describe("pagination failure (429 storm regression)", () => {
    it("a failed page load stops auto-pagination; the retry button recovers", async () => {
      // jsdom's IO mock reports the sentinel intersecting immediately,
      // so with a next_url the continuation fires on its own — same
      // geometry as the grid-mode bug on a real phone. Street
      // continuations are another POST /api/street carrying the cursor.
      let streetCalls = 0;
      server.use(
        http.post("/api/street", () => {
          streetCalls++;
          if (streetCalls === 1)
            return json(makeFeedOf(30, 1, "/api/next?cursor=p2"));
          if (streetCalls === 2)
            return new HttpResponse("429: rate limited\n", { status: 429 });
          return json(makeFeedOf(10, 100, null));
        })
      );
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(container.querySelectorAll(".feed-card").length).toBe(30)
      );
      await waitFor(() =>
        expect(requestCount("/api/street")).toBe(2)
      );
      // The failure surfaces the retry button…
      await waitFor(() =>
        expect(
          container.querySelector(".feed-sentinel .mode-pill")?.textContent
        ).toContain("Couldn't load")
      );
      // …and MUST NOT auto-retry: after a long settle, still exactly 2.
      await new Promise((r) => setTimeout(r, 400));
      expect(requestCount("/api/street")).toBe(2);

      // The retry button recovers.
      await fireEvent.click(
        container.querySelector(".feed-sentinel .mode-pill")!
      );
      await waitFor(() =>
        expect(requestCount("/api/street")).toBe(3)
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
      let streetCalls = 0;
      server.use(
        http.post("/api/street", () => {
          streetCalls++;
          if (streetCalls === 2)
            return new HttpResponse("429: rate limited\n", { status: 429 });
          if (streetCalls === 4) return json(makeFeedOf(10, 100, null));
          return json(makeFeedOf(30, 1, "/api/next?cursor=p2"));
        })
      );
      const { container } = render(() => <App />);
      await waitFor(() =>
        expect(requestCount("/api/street")).toBe(2)
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
      expect(requestCount("/api/street")).toBe(4);
    });
  });
