import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { http, HttpResponse } from "msw";
import FeedCard from "./FeedCard";
import { TAP_WINDOW_MS, __resetClickBudgetForTests } from "./gestures";
import { makeIllust, makeMultiPageIllust } from "../../test-fixtures";
import { requestCount, requestsTo, server } from "../../test/msw/server";

/** Touch-point shape for jsdom's TouchEvent (no Touch constructor). */
interface Pt {
  clientX: number;
  clientY: number;
  identifier: number;
}

const pt = (x: number, y = 100, identifier = 0): Pt => ({
  clientX: x,
  clientY: y,
  identifier,
});

/**
 * jsdom has TouchEvent but no Touch constructor; its init accepts plain
 * coordinate objects (verified), so the card's real listeners run.
 */
function fireTouch(
  el: Element,
  type: string,
  touches: Pt[],
  changed: Pt[] = touches
) {
  fireEvent(
    el,
    new TouchEvent(type, {
      touches: touches as unknown as Touch[],
      changedTouches: changed as unknown as Touch[],
      bubbles: true,
      cancelable: true,
      composed: true,
    })
  );
}

function tapCard(el: Element, x = 100, y = 100) {
  fireTouch(el, "touchstart", [pt(x, y)]);
  fireTouch(el, "touchend", [], [pt(x, y)]);
}

function pinch(el: Element, from: [number, number], to: [number, number]) {
  const start: Pt[] = [pt(from[0]), pt(from[1], 100, 1)];
  const end: Pt[] = [pt(to[0]), pt(to[1], 100, 1)];
  fireTouch(el, "touchstart", start);
  fireTouch(el, "touchmove", end);
  fireTouch(el, "touchend", [], end);
}

// Real api/illust + api/follow -> request() -> MSW. Heart clicks assert
// the wire POSTs (/api/illust/:id/like|unlike) instead of a module mock;
// FollowButton's getFollowed answers from the shared default handler.

beforeEach(() => __resetClickBudgetForTests());

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

describe("FeedCard touch gestures", () => {
  it("double-tap toggles like through the same path as the heart", async () => {
    const illust = makeIllust({ id: 1 });
    const onLike = vi.fn();
    const onTap = vi.fn();
    const { container } = render(() => (
      <FeedCard illust={illust} onLike={onLike} onTap={onTap} />
    ));
    const card = container.querySelector(".feed-card")!;
    const heart = container.querySelector(".like-btn") as HTMLButtonElement;

    tapCard(card, 100, 100);
    tapCard(card, 103, 102);
    await waitFor(() => expect(onLike).toHaveBeenCalledWith(illust));
    expect(requestsTo("/api/illust/1/like")).toHaveLength(1);
    expect(heart.textContent).toBe("❤️");
    expect(onTap).not.toHaveBeenCalled(); // double-tap is a like, not a stack
    expect(container.querySelector(".heart-flash")).toBeTruthy();

    await new Promise((r) => setTimeout(r, 0));
    tapCard(card, 100, 100);
    tapCard(card, 103, 102);
    await waitFor(() =>
      expect(requestsTo("/api/illust/1/unlike")).toHaveLength(1)
    );
    expect(heart.textContent).toBe("🤍");
    expect(container.querySelectorAll(".heart-flash").length).toBe(1);
  });

  it("defers a touch single tap; the synthetic click must not double-fire", () => {
    const illust = makeIllust({ id: 1 });
    const onTap = vi.fn();
    const { container } = render(() => (
      <FeedCard illust={illust} onTap={onTap} />
    ));
    vi.useFakeTimers();
    try {
      const card = container.querySelector(".feed-card")!;
      tapCard(card);
      fireEvent.click(card); // iOS synthetic click right after touchend
      expect(onTap).not.toHaveBeenCalled();
      vi.advanceTimersByTime(TAP_WINDOW_MS - 1);
      expect(onTap).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTap).toHaveBeenCalledTimes(1);
      expect(onTap).toHaveBeenCalledWith(illust);
    } finally {
      vi.useRealTimers();
    }
  });

  it("movement beyond the slop is a swipe, not a tap", () => {
    const illust = makeIllust({ id: 1 });
    const onTap = vi.fn();
    const { container } = render(() => (
      <FeedCard illust={illust} onTap={onTap} />
    ));
    vi.useFakeTimers();
    try {
      const card = container.querySelector(".feed-card")!;
      fireTouch(card, "touchstart", [pt(100, 100)]);
      fireTouch(card, "touchmove", [pt(160, 100)]);
      fireTouch(card, "touchend", [], [pt(160, 100)]);
      vi.advanceTimersByTime(1000);
      expect(onTap).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pinch-spread enters immersive and pinch-in restores", () => {
    const illust = makeIllust({ id: 1 });
    const onImmersiveChange = vi.fn();
    const { container } = render(() => (
      <div class="feed-container">
        <FeedCard illust={illust} onImmersiveChange={onImmersiveChange} />
      </div>
    ));
    const card = container.querySelector(".feed-card") as HTMLElement;

    pinch(card, [150, 250], [0, 400]); // 100 → 400 apart
    expect(card.classList.contains("immersive")).toBe(true);
    expect(onImmersiveChange).toHaveBeenLastCalledWith(true);
    expect(container.querySelector(".card-immersive-restore")).toBeTruthy();

    pinch(card, [0, 400], [150, 250]); // 400 → 100 apart
    expect(card.classList.contains("immersive")).toBe(false);
    expect(onImmersiveChange).toHaveBeenLastCalledWith(false);
    expect(container.querySelector(".card-immersive-restore")).toBeNull();
  });

  it("a pinch under the threshold leaves the chrome alone", () => {
    const illust = makeIllust({ id: 1 });
    const onImmersiveChange = vi.fn();
    const { container } = render(() => (
      <FeedCard illust={illust} onImmersiveChange={onImmersiveChange} />
    ));
    pinch(container.querySelector(".feed-card")!, [150, 250], [130, 270]);
    expect(onImmersiveChange).not.toHaveBeenCalled();
    expect(container.querySelector(".feed-card")!.classList.contains("immersive")).toBe(
      false
    );
  });

  it("tapping while immersive restores only — never opens a stack", () => {
    const illust = makeIllust({ id: 1 });
    const onTap = vi.fn();
    const onImmersiveChange = vi.fn();
    const { container } = render(() => (
      <div class="feed-container">
        <FeedCard
          illust={illust}
          onTap={onTap}
          onImmersiveChange={onImmersiveChange}
        />
      </div>
    ));
    const card = container.querySelector(".feed-card") as HTMLElement;
    pinch(card, [150, 250], [0, 400]);
    expect(card.classList.contains("immersive")).toBe(true);

    vi.useFakeTimers();
    try {
      tapCard(card);
      vi.advanceTimersByTime(TAP_WINDOW_MS);
      expect(card.classList.contains("immersive")).toBe(false);
      expect(onTap).not.toHaveBeenCalled();
      expect(onImmersiveChange).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the restore icon exits immersive without opening the stack", () => {
    const illust = makeIllust({ id: 1 });
    const onTap = vi.fn();
    const { container } = render(() => (
      <FeedCard illust={illust} onTap={onTap} />
    ));
    const card = container.querySelector(".feed-card") as HTMLElement;
    pinch(card, [150, 250], [0, 400]);

    fireEvent.click(container.querySelector(".card-immersive-restore")!);
    expect(card.classList.contains("immersive")).toBe(false);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("scrolling the feed container cancels immersive", () => {
    const illust = makeIllust({ id: 1 });
    const onImmersiveChange = vi.fn();
    const { container } = render(() => (
      <div class="feed-container">
        <FeedCard illust={illust} onImmersiveChange={onImmersiveChange} />
      </div>
    ));
    const card = container.querySelector(".feed-card") as HTMLElement;
    pinch(card, [150, 250], [0, 400]);
    expect(card.classList.contains("immersive")).toBe(true);

    fireEvent.scroll(container.querySelector(".feed-container")!);
    expect(card.classList.contains("immersive")).toBe(false);
    expect(onImmersiveChange).toHaveBeenLastCalledWith(false);
  });

  it("suppressImages (covered layer) resets immersive", () => {
    const illust = makeIllust({ id: 1 });
    const [suppress, setSuppress] = createSignal(false);
    const onImmersiveChange = vi.fn();
    const { container } = render(() => (
      <div class="feed-container">
        <FeedCard
          illust={illust}
          suppressImages={suppress()}
          onImmersiveChange={onImmersiveChange}
        />
      </div>
    ));
    const card = container.querySelector(".feed-card") as HTMLElement;
    pinch(card, [150, 250], [0, 400]);
    expect(card.classList.contains("immersive")).toBe(true);

    setSuppress(true);
    expect(card.classList.contains("immersive")).toBe(false);
    expect(onImmersiveChange).toHaveBeenLastCalledWith(false);
  });
});

describe("FeedCard selection mode (bookmarks → private)", () => {
  it("desktop click toggles selection instead of opening a stack", async () => {
    const illust = makeIllust({ id: 7 });
    const onTap = vi.fn();
    const onSelectToggle = vi.fn();
    const { container } = render(() => (
      <FeedCard
        illust={illust}
        onTap={onTap}
        selectable
        selected={false}
        onSelectToggle={onSelectToggle}
      />
    ));

    await fireEvent.click(container.querySelector(".card-overlay")!);
    expect(onSelectToggle).toHaveBeenCalledWith(7);
    expect(onTap).not.toHaveBeenCalled();
    expect(container.querySelector(".card-select-box")).toBeTruthy();
    expect(container.querySelector(".card-select-box")!.textContent).toBe("");
  });

  it("renders the checked checkbox when selected", () => {
    const illust = makeIllust({ id: 7 });
    const { container } = render(() => (
      <FeedCard illust={illust} selectable selected onSelectToggle={() => {}} />
    ));
    const box = container.querySelector(".card-select-box")!;
    expect(box.classList.contains("checked")).toBe(true);
    expect(box.textContent).toBe("✓");
    expect(container.querySelector(".feed-card")!.classList.contains("selected")).toBe(
      true
    );
  });

  it("touch single tap toggles selection (deferred), never opens a stack", async () => {
    const illust = makeIllust({ id: 7 });
    const onTap = vi.fn();
    const onSelectToggle = vi.fn();
    const { container } = render(() => (
      <FeedCard
        illust={illust}
        onTap={onTap}
        selectable
        onSelectToggle={onSelectToggle}
      />
    ));
    const card = container.querySelector(".feed-card")!;

    vi.useFakeTimers();
    try {
      tapCard(card);
      expect(onSelectToggle).not.toHaveBeenCalled();
      vi.advanceTimersByTime(TAP_WINDOW_MS);
      expect(onSelectToggle).toHaveBeenCalledWith(7);
      expect(onTap).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("double-tap is inert in selection mode — no like, no selection flip", async () => {
    const illust = makeIllust({ id: 7 });
    const onSelectToggle = vi.fn();
    const { container } = render(() => (
      <FeedCard illust={illust} selectable onSelectToggle={onSelectToggle} />
    ));
    const card = container.querySelector(".feed-card")!;

    tapCard(card, 100, 100);
    tapCard(card, 103, 102);
    await new Promise((r) => setTimeout(r, 0));

    expect(onSelectToggle).not.toHaveBeenCalled();
    expect(requestsTo("/api/illust/7/like")).toHaveLength(0);
    expect(requestsTo("/api/illust/7/unlike")).toHaveLength(0);
    expect(container.querySelector(".heart-flash")).toBeNull();
  });

  it("keeps the heart control functional while selectable", async () => {
    const illust = makeIllust({ id: 7 });
    const onSelectToggle = vi.fn();
    const { container } = render(() => (
      <FeedCard illust={illust} selectable onSelectToggle={onSelectToggle} />
    ));
    await fireEvent.click(container.querySelector(".like-btn")!);
    await waitFor(() =>
      expect(requestsTo("/api/illust/7/like")).toHaveLength(1)
    );
    expect(onSelectToggle).not.toHaveBeenCalled();
  });
});
