import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { http, HttpResponse } from "msw";
import FeedCard from "./FeedCard";
import { makeIllust, makeMultiPageIllust } from "../../test-fixtures";
import { requestCount, requestsTo, server } from "../../test/msw/server";

// Real api/illust + api/follow -> request() -> MSW. Heart clicks assert
// the wire POSTs (/api/illust/:id/like|unlike) instead of a module mock;
// FollowButton's getFollowed answers from the shared default handler.

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
    expect(requestsTo("/api/illust/1/like")).toHaveLength(1);
    expect(btn.textContent).toBe("❤️");

    // The in-flight lock releases when the POST settles (MSW resolves
    // over microtasks) — flush a macrotask before the unlike tap.
    await new Promise((r) => setTimeout(r, 0));
    await fireEvent.click(btn);
    expect(requestsTo("/api/illust/1/unlike")).toHaveLength(1);
    expect(btn.textContent).toBe("🤍");
  });

  it("reverts the heart when the API rejects", async () => {
    server.use(
      http.post("/api/illust/:id/like", () =>
        new HttpResponse("upstream error\n", { status: 502 })
      )
    );
    const illust = makeIllust({ id: 1 });
    const { container } = render(() => <FeedCard illust={illust} />);
    const btn = container.querySelector(".like-btn") as HTMLButtonElement;

    await fireEvent.click(btn);
    await waitFor(() => expect(btn.textContent).toBe("🤍")); // reverted
  });

  it("ignores double-taps while a request is in flight", async () => {
    let releaseLike!: () => void;
    const pending = new Promise<void>((res) => {
      releaseLike = res;
    });
    server.use(
      http.post("/api/illust/:id/like", async () => {
        await pending;
        return HttpResponse.json({ ok: true });
      })
    );
    const illust = makeIllust({ id: 1 });
    const { container } = render(() => <FeedCard illust={illust} />);
    const btn = container.querySelector(".like-btn") as HTMLButtonElement;

    await fireEvent.click(btn);
    await fireEvent.click(btn); // busy — ignored
    expect(requestCount("/api/illust/1/like")).toBe(1);

    releaseLike();
  });

  it("calls onLike after a successful like", async () => {
    const onLike = vi.fn();
    const illust = makeIllust({ id: 7 });
    const { container } = render(() => (
      <FeedCard illust={illust} onLike={onLike} />
    ));
    await fireEvent.click(container.querySelector(".like-btn")!);
    await waitFor(() => expect(onLike).toHaveBeenCalledWith(illust));
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
