import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import SearchScreen from "./SearchScreen";
import { makeFeedOf } from "../test-fixtures";

vi.mock("../api", () => ({
  api: {
    searchArtworks: vi.fn(),
    searchUsers: vi.fn(),
    like: vi.fn(async () => {}),
    unlike: vi.fn(async () => {}),
    getUgoiraMeta: vi.fn(async () => ({ error: false, body: { src: "z", frames: [] } })),
  },
}));

import { api } from "../api";
const mockedApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

function artworksResp(page: number, lastPage: number) {
  return {
    illusts: makeFeedOf(3, page * 100).illusts,
    total: 900,
    last_page: lastPage,
    page,
    next_url: null,
    popular: makeFeedOf(2, 5000).illusts,
    related_tags: [
      { name: "幻想", translated_name: "fantasy" },
      { name: "ファンタジー", translated_name: "" },
    ],
  };
}

function usersResp() {
  return {
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
    total: 5,
    page: 1,
    next_url: null,
  };
}

beforeEach(() => {
  mockedApi.searchArtworks.mockReset().mockResolvedValue(artworksResp(1, 1));
  mockedApi.searchUsers.mockReset().mockResolvedValue(usersResp());
});

const baseProps = {
  zIndex: 50,
  onClose: () => {},
  onImageTap: () => {},
  onArtistOpen: () => {},
  onUserOpen: () => {},
  onTagsTap: () => {},
};

describe("SearchScreen", () => {
  it("shows the empty prompt before any search", () => {
    const { container } = render(() => <SearchScreen {...baseProps} />);
    expect(container.textContent).toContain("Search pixiv");
  });

  it("searches works on submit and renders results", async () => {
    const { container } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(mockedApi.searchArtworks).toHaveBeenCalledWith({
        word: "fantasy",
        order: "date_d",
        contentMode: "all",
        workType: "all",
        sMode: "s_tag_full",
        aiType: "0",
        scd: "",
        sce: "",
        p: 1,
      })
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(3)
    );
  });

  it("shows the popular strip and related tag pills on page 1", async () => {
    const { container } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(container.querySelector(".search-popular-strip")).not.toBeNull()
    );
    expect(container.querySelectorAll(".search-popular-item").length).toBe(2);
    expect(container.querySelectorAll(".search-related-pill").length).toBe(2);
  });

  it("tapping a related tag re-searches that tag", async () => {
    const { container } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(container.querySelectorAll(".search-related-pill").length).toBe(2)
    );
    await fireEvent.click(
      container.querySelectorAll(".search-related-pill")[0]
    );
    await waitFor(() =>
      expect(mockedApi.searchArtworks).toHaveBeenLastCalledWith({
        word: "幻想",
        order: "date_d",
        contentMode: "all",
        workType: "all",
        sMode: "s_tag_full",
        aiType: "0",
        scd: "",
        sce: "",
        p: 1,
      })
    );
  });

  it("switches to artists mode and renders user rows with previews", async () => {
    const { container, getByText } = render(() => (
      <SearchScreen {...baseProps} />
    ));
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(3)
    );
    await fireEvent.click(getByText("Artists"));
    await waitFor(() =>
      expect(mockedApi.searchUsers).toHaveBeenCalledWith("fantasy", 1)
    );
    await waitFor(() =>
      expect(container.querySelector(".search-user-row")).not.toBeNull()
    );
    expect(container.querySelector(".search-user-name")?.textContent).toBe(
      "User One"
    );
    expect(container.querySelectorAll(".search-user-preview").length).toBe(3);
  });

  it("paginates works via the sentinel", async () => {
    mockedApi.searchArtworks
      .mockResolvedValueOnce(artworksResp(1, 2))
      .mockResolvedValueOnce(artworksResp(2, 2));
    const { container } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(mockedApi.searchArtworks).toHaveBeenCalledTimes(2)
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(6)
    );
  });

  it("switching modes mid-search supersedes the in-flight run (no stranded spinner)", async () => {
    // The old code stranded loading=true forever when a mode pill was
    // tapped during an in-flight search (stale run's finally skipped
    // setLoading, new run blocked by the loading guard).
    mockedApi.searchArtworks.mockImplementation(
      () => new Promise((res) => setTimeout(() => res(artworksResp(1, 1)), 50))
    );
    const { container, getByText } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    // Tap Artists while the works search is still in flight.
    await fireEvent.click(getByText("Artists"));
    await waitFor(() =>
      expect(mockedApi.searchUsers).toHaveBeenCalledWith("fantasy", 1)
    );
    await waitFor(() =>
      expect(container.querySelector(".search-user-row")).not.toBeNull()
    );
    expect(container.querySelector(".spinner")).toBeNull();
  });

  it("fresh searches don't dedupe against the previous search's works", async () => {
    // Both searches return the same id range (100..) — the second must
    // still render them; the seen-set must reset per fresh search.
    mockedApi.searchArtworks
      .mockResolvedValueOnce(artworksResp(1, 1))
      .mockResolvedValueOnce(artworksResp(1, 1));
    const { container } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "goku" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(3)
    );
    await fireEvent.input(input, { target: { value: "vegeta" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(3)
    );
  });

  it("opening Filters and picking a content mode refetches with the new mode", async () => {
    const { container, getByText } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(mockedApi.searchArtworks).toHaveBeenCalled());

    await fireEvent.click(getByText("Filters"));
    await fireEvent.click(getByText("All ages"));
    await waitFor(() =>
      expect(mockedApi.searchArtworks).toHaveBeenLastCalledWith(
        expect.objectContaining({ word: "fantasy", contentMode: "safe", p: 1 })
      )
    );
  });

  it("the Filters button shows a badge when filters are active and Reset clears it", async () => {
    const { container, getByText } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(mockedApi.searchArtworks).toHaveBeenCalled());

    expect(container.querySelector(".filter-badge")).toBeNull();
    await fireEvent.click(getByText("Filters"));
    await fireEvent.click(getByText("Oldest"));
    await fireEvent.click(getByText("Hide"));
    await waitFor(() =>
      expect(container.querySelector(".filter-badge")?.textContent).toBe("2")
    );
    await fireEvent.click(getByText("Reset"));
    await waitFor(() => expect(container.querySelector(".filter-badge")).toBeNull());
    await waitFor(() =>
      expect(mockedApi.searchArtworks).toHaveBeenLastCalledWith(
        expect.objectContaining({ order: "date_d", aiType: "0" })
      )
    );
  });

  it("picking Illustrations only passes workType=illust", async () => {
    const { container, getByText } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(mockedApi.searchArtworks).toHaveBeenCalled());

    await fireEvent.click(getByText("Filters"));
    await fireEvent.click(getByText("Illustrations only"));
    await waitFor(() =>
      expect(mockedApi.searchArtworks).toHaveBeenLastCalledWith(
        expect.objectContaining({ workType: "illust" })
      )
    );
  });

  it("picking Ugoira only passes workType=ugoira", async () => {
    const { container, getByText } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(mockedApi.searchArtworks).toHaveBeenCalled());

    await fireEvent.click(getByText("Filters"));
    await fireEvent.click(getByText("Ugoira only"));
    await waitFor(() =>
      expect(mockedApi.searchArtworks).toHaveBeenLastCalledWith(
        expect.objectContaining({ workType: "ugoira" })
      )
    );
  });

  it("Custom posting date reveals date inputs and applies scd/sce", async () => {
    const { container, getByText } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(mockedApi.searchArtworks).toHaveBeenCalled());

    await fireEvent.click(getByText("Filters"));
    await fireEvent.click(getByText("Custom"));
    const from = container.querySelector(
      'input[aria-label="From date"]'
    ) as HTMLInputElement;
    expect(from).not.toBeNull();
    await fireEvent.input(from, { target: { value: "2026-06-01" } });
    await fireEvent.input(
      container.querySelector('input[aria-label="To date"]') as HTMLInputElement,
      { target: { value: "2026-06-30" } }
    );
    await waitFor(() =>
      expect(mockedApi.searchArtworks).toHaveBeenLastCalledWith(
        expect.objectContaining({ scd: "2026-06-01", sce: "2026-06-30" })
      )
    );
  });

  it("a restored search that returns zero works does NOT re-query forever", async () => {
    // iOS kill → snapshot restore lands here with an empty works array.
    // The auto-run effect used to refire every time loading() flipped
    // false — a zero-result search looped indefinitely (constant
    // "reloading"). It must attempt exactly once and stop.
    mockedApi.searchArtworks.mockImplementation(
      () =>
        new Promise((res) =>
          setTimeout(
            () =>
              res({
                illusts: [],
                total: 0,
                last_page: 0,
                page: 1,
                next_url: null,
                popular: [],
                related_tags: [],
              }),
            10
          )
        )
    );
    const { container } = render(() => (
      <SearchScreen
        {...baseProps}
        initial={{
          word: "no such tag",
          mode: "works",
          order: "date_d",
          contentMode: "all",
          workType: "all",
          sMode: "s_tag_full",
          aiType: "0",
          dateMode: "all",
          scd: "",
          sce: "",
          works: [],
          popular: [],
          related: [],
          users: [],
          page: 0,
          hasMore: false,
        }}
      />
    ));
    await waitFor(() => expect(mockedApi.searchArtworks).toHaveBeenCalled());
    // Give any runaway loop time to fire extra calls, then assert one.
    await new Promise((r) => setTimeout(r, 120));
    expect(mockedApi.searchArtworks).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("No results");
  });

  it("a restored search that FAILS does not retry in an infinite loop", async () => {
    mockedApi.searchArtworks.mockRejectedValue(new Error("boom"));
    const { container } = render(() => (
      <SearchScreen
        {...baseProps}
        initial={{
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
          works: [],
          popular: [],
          related: [],
          users: [],
          page: 0,
          hasMore: false,
        }}
      />
    ));
    await waitFor(() => expect(mockedApi.searchArtworks).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 120));
    expect(mockedApi.searchArtworks).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Couldn't search");
  });
});


describe("SearchScreen pagination failure", () => {
  it("a failed next page stops auto-pagination; the retry button recovers", async () => {
    // Page 1 (last_page 2) succeeds → hasMore true → the sentinel
    // auto-fires page 2, which fails → must NOT storm.
    mockedApi.searchArtworks
      .mockResolvedValueOnce(artworksResp(1, 2))
      .mockRejectedValueOnce(new Error("429: rate limited"))
      .mockResolvedValueOnce(artworksResp(2, 2));
    const { container } = render(() => <SearchScreen {...baseProps} />);
    const input = container.querySelector(".search-input") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "fantasy" } });
    await fireEvent.submit(input.closest("form")!);

    await waitFor(() =>
      expect(mockedApi.searchArtworks).toHaveBeenCalledTimes(2)
    );
    await waitFor(() =>
      expect(
        container.querySelector(".feed-sentinel .mode-pill")?.textContent
      ).toContain("Couldn't load")
    );

    // No storm: still exactly 2 after a long settle.
    await new Promise((r) => setTimeout(r, 400));
    expect(mockedApi.searchArtworks).toHaveBeenCalledTimes(2);

    // Retry recovers: page 2 lands, 6 works total.
    await fireEvent.click(
      container.querySelector(".feed-sentinel .mode-pill")!
    );
    await waitFor(() =>
      expect(mockedApi.searchArtworks).toHaveBeenCalledTimes(3)
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(6)
    );
    // hasMore false (p=2 = last_page) → no further fires.
    await new Promise((r) => setTimeout(r, 400));
    expect(mockedApi.searchArtworks).toHaveBeenCalledTimes(3);
  });
});
