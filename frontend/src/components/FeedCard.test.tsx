import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import FeedCard from "./FeedCard";
import { makeIllust, makeMultiPageIllust } from "../test-fixtures";

vi.mock("../api/illust", () => ({
  like: vi.fn(async () => {}),
  unlike: vi.fn(async () => {}),
}));
vi.mock("../api/follow", () => ({
  follow: vi.fn(async () => {}),
  unfollow: vi.fn(async () => {}),
  getFollowed: vi.fn(),
}));
vi.mock("../api/client", async () => {
  const actual = await vi.importActual("../api/client");
  return { logEvent: vi.fn(), reportApiError: vi.fn(), ApiError: actual.ApiError };
});

import * as illust from "../api/illust";
import * as follow from "../api/follow";
const mockedApi = {
  ...illust,
  ...follow,
} as unknown as {
  like: ReturnType<typeof vi.fn>;
  unlike: ReturnType<typeof vi.fn>;
  getFollowed: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockedApi.like.mockReset().mockResolvedValue(undefined);
  mockedApi.unlike.mockReset().mockResolvedValue(undefined);
  mockedApi.getFollowed.mockReset().mockResolvedValue({ followed: false });
});

describe("FeedCard", () => {
  it("renders title, artist, and stats", () => {
    const illust = makeIllust({ id: 1, title: "Great Work" });
    const { getByText } = render(() => <FeedCard illust={illust} />);
    expect(getByText("Great Work")).toBeTruthy();
    expect(getByText(/Artist 1/)).toBeTruthy();
  });

  it("optimistically toggles the heart and likes", async () => {
    const illust = makeIllust({ id: 1 });
    const { container } = render(() => <FeedCard illust={illust} />);
    const btn = container.querySelector(".like-btn") as HTMLButtonElement;
    expect(btn.textContent).toBe("🤍");

    await fireEvent.click(btn);
    expect(mockedApi.like).toHaveBeenCalledWith(1);
    expect(btn.textContent).toBe("❤️");

    await fireEvent.click(btn);
    expect(mockedApi.unlike).toHaveBeenCalledWith(1);
    expect(btn.textContent).toBe("🤍");
  });

  it("reverts the heart when the API rejects", async () => {
    mockedApi.like.mockRejectedValue(new Error("like failed: 401"));
    const illust = makeIllust({ id: 1 });
    const { container } = render(() => <FeedCard illust={illust} />);
    const btn = container.querySelector(".like-btn") as HTMLButtonElement;

    await fireEvent.click(btn);
    expect(btn.textContent).toBe("🤍"); // reverted
  });

  it("ignores double-taps while a request is in flight", async () => {
    let resolveLike!: () => void;
    mockedApi.like.mockImplementation(
      () => new Promise<void>((res) => { resolveLike = res; })
    );
    const illust = makeIllust({ id: 1 });
    const { container } = render(() => <FeedCard illust={illust} />);
    const btn = container.querySelector(".like-btn") as HTMLButtonElement;

    await fireEvent.click(btn);
    await fireEvent.click(btn); // busy — ignored
    expect(mockedApi.like).toHaveBeenCalledTimes(1);

    resolveLike();
  });

  it("calls onLike after a successful like", async () => {
    const onLike = vi.fn();
    const illust = makeIllust({ id: 7 });
    const { container } = render(() => (
      <FeedCard illust={illust} onLike={onLike} />
    ));
    await fireEvent.click(container.querySelector(".like-btn")!);
    expect(onLike).toHaveBeenCalledWith(illust);
  });

  it("onTap fires for card body but not for like button or artist link", async () => {
    const onTap = vi.fn();
    const illust = makeIllust({ id: 1 });
    const { container } = render(() => (
      <FeedCard illust={illust} onTap={onTap} />
    ));

    await fireEvent.click(container.querySelector(".card-overlay")!);
    expect(onTap).toHaveBeenCalledWith(illust);
    onTap.mockClear();

    await fireEvent.click(container.querySelector(".like-btn")!);
    expect(onTap).not.toHaveBeenCalled();

    await fireEvent.click(container.querySelector("a")!);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("tags button fires onTagsTap and never the card tap", async () => {
    const onTap = vi.fn();
    const onTagsTap = vi.fn();
    const illust = makeIllust({ id: 1 });
    const { container } = render(() => (
      <FeedCard illust={illust} onTap={onTap} onTagsTap={onTagsTap} />
    ));

    await fireEvent.click(container.querySelector(".tags-btn")!);
    expect(onTagsTap).toHaveBeenCalledWith(illust);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("renders tag chips for the work's tags", () => {
    const illust = makeIllust({
      id: 1,
      tags: [
        { name: "girl" },
        { name: "fantasy", translated_name: "fantasy" },
      ],
    });
    const { container } = render(() => <FeedCard illust={illust} />);
    const chips = container.querySelectorAll(".card-tag-chip");
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toBe("#girl");
    expect(chips[1].textContent).toBe("#fantasy");
  });

  it("renders every tag in the scrollable row", () => {
    const illust = makeIllust({
      id: 1,
      tags: [1, 2, 3, 4, 5].map((n) => ({ name: `tag${n}` })),
    });
    const { container } = render(() => <FeedCard illust={illust} />);
    // All chips render; the row scrolls to reveal overflow (no +N).
    expect(container.querySelectorAll(".card-tag-chip").length).toBe(5);
    expect(container.querySelector(".card-tag-row")?.className).toContain(
      "fade-edges"
    );
    expect(container.querySelector(".card-tag-row")?.className).toContain(
      "no-scrollbar"
    );
  });

  it("tapping a tag chip opens the tag page, not the card", async () => {
    const onTap = vi.fn();
    const onTagOpen = vi.fn();
    const illust = makeIllust({ id: 1, tags: [{ name: "girl" }] });
    const { container } = render(() => (
      <FeedCard illust={illust} onTap={onTap} onTagOpen={onTagOpen} />
    ));
    await fireEvent.click(container.querySelector(".card-tag-chip")!);
    expect(onTagOpen).toHaveBeenCalledWith("girl");
    expect(onTap).not.toHaveBeenCalled();
  });

  it("uses the gear icon for the blocking button", () => {
    const illust = makeIllust({ id: 1 });
    const { container } = render(() => <FeedCard illust={illust} />);
    const btn = container.querySelector(".tags-btn") as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toBe("Block this work's tags");
    expect(btn.textContent).toContain("⚙");
  });

  it("renders a page counter for multi-page illusts", () => {
    const illust = makeMultiPageIllust(1, 3);
    const { getByText } = render(() => <FeedCard illust={illust} />);
    expect(getByText("1/3")).toBeTruthy();
  });

  it("does not render the slider for single-page illusts", () => {
    const illust = makeIllust({ id: 1 });
    const { container } = render(() => <FeedCard illust={illust} />);
    expect(container.querySelector(".card-pages")).toBeNull();
  });
});
