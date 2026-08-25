import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import RelatedView from "./RelatedView";
import { makeFeedOf } from "../test-fixtures";

vi.mock("../api", () => ({
  api: {
    getRelated: vi.fn(),
    getNextPage: vi.fn(),
    like: vi.fn(async () => {}),
    unlike: vi.fn(async () => {}),
    follow: vi.fn(async () => {}),
    unfollow: vi.fn(async () => {}),
    getFollowed: vi.fn(async () => ({ followed: false })),
    getUgoiraMeta: vi.fn(async () => ({ error: false, body: { src: "z", frames: [] } })),
  },
  logEvent: vi.fn(),
}));

import { api } from "../api";
const mockedApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const anchor = makeFeedOf(1, 900).illusts[0];

const baseProps = {
  anchor,
  zIndex: 50,
  depth: 1,
  maxDepth: 10,
  onClose: () => {},
  onCloseAll: () => {},
  onPush: () => {},
  onArtistTap: () => {},
  onTagsTap: () => {},
};

beforeEach(() => {
  mockedApi.getRelated.mockReset();
  mockedApi.getNextPage.mockReset().mockResolvedValue({ illusts: [], next_url: null });
});

describe("RelatedView initial-load failure", () => {
  it("a failed initial load offers a retry button that recovers", async () => {
    mockedApi.getRelated
      .mockRejectedValueOnce(new Error("upstream down"))
      .mockResolvedValueOnce({
        illusts: makeFeedOf(3, 100).illusts,
        next_url: null,
      });
    const { container } = render(() => <RelatedView {...baseProps} />);
    // The anchor renders immediately; the initial fetch fails.
    await waitFor(() =>
      expect(container.querySelector(".feed-sentinel .mode-pill")?.textContent).toContain(
        "Couldn't load related works"
      )
    );
    // Retry succeeds: the fresh works land, no error remains.
    await fireEvent.click(container.querySelector(".feed-sentinel .mode-pill")!);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(4) // anchor + 3
    );
    expect(container.querySelector(".feed-sentinel .mode-pill")).toBeNull();
  });
});
