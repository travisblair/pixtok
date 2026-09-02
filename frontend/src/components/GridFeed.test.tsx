import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import GridFeed from "./GridFeed";
import { makeIllust, makeFeedOf } from "../test-fixtures";
import { getLikeState } from "../store";

vi.mock("../api", () => ({
  api: {
    like: vi.fn(async () => {}),
    unlike: vi.fn(async () => {}),
    getUgoiraMeta: vi.fn(),
  },
  logEvent: vi.fn(),
}));

import { api } from "../api";
const mockedApi = api as unknown as {
  like: ReturnType<typeof vi.fn>;
  unlike: ReturnType<typeof vi.fn>;
  getUgoiraMeta: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mockedApi.like.mockReset().mockResolvedValue(undefined);
  mockedApi.unlike.mockReset().mockResolvedValue(undefined);
  mockedApi.getUgoiraMeta
    .mockReset()
    .mockResolvedValue({ error: false, body: { src: "z", frames: [] } });
});

describe("GridFeed", () => {
  it("renders one cell per illust with square_medium through the proxy", () => {
    const illusts = makeFeedOf(3, 1).illusts;
    const { container } = render(() => <GridFeed illusts={illusts} />);
    const cells = container.querySelectorAll(".grid-cell");
    expect(cells).toHaveLength(3);
    const img = cells[0].querySelector("img");
    expect(img?.getAttribute("src")).toContain("/api/img?url=");
    expect(img?.getAttribute("src")).toContain(
      encodeURIComponent(illusts[0].image_urls.square_medium!)
    );
  });

  it("cells carry NO title/artist/tag text (grid is thumbnails only)", () => {
    const illust = makeIllust({ id: 1, title: "Hidden Title" });
    const { container, queryByText } = render(() => (
      <GridFeed illusts={[illust]} />
    ));
    expect(container.querySelector(".grid-cell")).toBeTruthy();
    expect(queryByText("Hidden Title")).toBeNull();
    expect(queryByText(/Artist 1/)).toBeNull();
  });

  it("tap on a cell opens the stack; heart tap does not", async () => {
    const onTap = vi.fn();
    const illusts = makeFeedOf(1, 1).illusts;
    const { container } = render(() => (
      <GridFeed illusts={illusts} onTap={onTap} />
    ));
    await fireEvent.click(container.querySelector(".grid-cell")!);
    expect(onTap).toHaveBeenCalledWith(illusts[0]);

    onTap.mockClear();
    await fireEvent.click(container.querySelector(".grid-cell-heart")!);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("heart likes/unlikes through the SHARED store and the API", async () => {
    const illusts = makeFeedOf(1, 1).illusts;
    const { container } = render(() => <GridFeed illusts={illusts} />);
    const btn = container.querySelector(
      ".grid-cell-heart"
    ) as HTMLButtonElement;
    expect(btn.textContent).toBe("🤍");

    await fireEvent.click(btn);
    expect(mockedApi.like).toHaveBeenCalledWith(illusts[0].id);
    expect(btn.textContent).toBe("❤️");
    // A strip card mounted elsewhere for the same illust sees the like.
    expect(getLikeState(illusts[0].id, false).liked()).toBe(true);

    await fireEvent.click(btn);
    expect(mockedApi.unlike).toHaveBeenCalledWith(illusts[0].id);
    expect(btn.textContent).toBe("🤍");
  });

  it("reverts the heart when the like POST fails", async () => {
    mockedApi.like.mockRejectedValue(new Error("like failed: 401"));
    const illusts = makeFeedOf(1, 1).illusts;
    const { container } = render(() => <GridFeed illusts={illusts} />);
    const btn = container.querySelector(
      ".grid-cell-heart"
    ) as HTMLButtonElement;
    await fireEvent.click(btn);
    expect(btn.textContent).toBe("🤍"); // reverted
  });

  it("ugoira cells render a play badge that does NOT open the stack", async () => {
    const onTap = vi.fn();
    const illusts = [makeIllust({ id: 9, type: "ugoira" })];
    const { container } = render(() => (
      <GridFeed illusts={illusts} onTap={onTap} />
    ));
    const badge = container.querySelector(".grid-cell-ugoira");
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toContain("▶");
    await fireEvent.click(badge!);
    expect(onTap).not.toHaveBeenCalled();
    // The player mounts inside the cell (canvas poster).
    expect(container.querySelector(".ugoira-wrap canvas")).toBeTruthy();
  });

  it("suppressImages swaps every src to the 1px placeholder", () => {
    const illusts = makeFeedOf(2, 1).illusts;
    const { container } = render(() => (
      <GridFeed illusts={illusts} suppressImages />
    ));
    for (const img of container.querySelectorAll("img")) {
      expect(img.getAttribute("src")).toMatch(/^data:image\/gif;base64/);
    }
  });

  it("fallback chain: square_medium missing → medium → large", () => {
    const illusts = [
      makeIllust({
        id: 3,
        image_urls: {
          medium: "https://i.pximg.net/m3.jpg",
          large: "https://i.pximg.net/l3.jpg",
        },
      }),
    ];
    const { container } = render(() => <GridFeed illusts={illusts} />);
    const src = container.querySelector("img")!.getAttribute("src")!;
    expect(src).toContain(encodeURIComponent("https://i.pximg.net/m3.jpg"));
  });

  // ── Scroll-based image window ───────────────────────────────────────
  // The MockIntersectionObserver (test-setup) fires isIntersecting on
  // observe(); these tests drive it manually to simulate scroll exit and
  // re-entry. Instances are per-cell in mount order; the most recent
  // instance belongs to the newest cell.
  function fireIO(target: Element, isIntersecting: boolean) {
    const IO = globalThis.IntersectionObserver as unknown as {
      instances: { callback: (entries: unknown[]) => void }[];
    };
    const io = IO.instances[IO.instances.length - 1];
    io.callback([{ isIntersecting, target }]);
  }

  it("cells scrolled out of the window unload to the placeholder after the 500ms hysteresis", () => {
    vi.useFakeTimers();
    const illusts = makeFeedOf(1, 1).illusts;
    const { container } = render(() => <GridFeed illusts={illusts} />);
    const cell = container.querySelector<HTMLElement>(".grid-cell")!;
    const img = cell.querySelector("img")!;
    expect(img.getAttribute("src")).toContain("/api/img?url="); // in window

    fireIO(cell, false);
    vi.advanceTimersByTime(499);
    expect(img.getAttribute("src")).toContain("/api/img?url="); // hysteresis holds

    vi.advanceTimersByTime(2);
    expect(img.getAttribute("src")).toMatch(/^data:image\/gif;base64/); // unloaded
    vi.useRealTimers();
  });

  it("cells re-entering the window restore their image src", () => {
    vi.useFakeTimers();
    const illusts = makeFeedOf(1, 1).illusts;
    const { container } = render(() => <GridFeed illusts={illusts} />);
    const cell = container.querySelector<HTMLElement>(".grid-cell")!;
    const img = cell.querySelector("img")!;

    fireIO(cell, false);
    vi.advanceTimersByTime(501);
    expect(img.getAttribute("src")).toMatch(/^data:image\/gif;base64/);

    fireIO(cell, true);
    expect(img.getAttribute("src")).toContain("/api/img?url="); // restored
    vi.useRealTimers();
  });
});
