import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import RecsModal from "./RecsModal";
import { makeFeedOf } from "../test-fixtures";

describe("RecsModal", () => {
  it("renders every rec as a card", () => {
    const recs = makeFeedOf(5, 100).illusts;
    const onClose = vi.fn();
    const { container } = render(() => (
      <RecsModal recs={recs} onClose={onClose} />
    ));
    expect(container.querySelectorAll(".feed-card").length).toBe(5);
  });

  it("closes via the ✕ button", async () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <RecsModal recs={[]} onClose={onClose} />
    ));
    await fireEvent.click(container.querySelector(".recs-close")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders the source title when provided", () => {
    const { container } = render(() => (
      <RecsModal recs={[]} sourceTitle="リバーレリオ" onClose={() => {}} />
    ));
    expect(container.querySelector(".recs-source")?.textContent).toContain(
      "リバーレリオ"
    );
  });

  it("the modal's own background is visual-only — no click handler (the ✕ closes)", async () => {
    const onClose = vi.fn();
    const { container } = render(() => (
      <RecsModal recs={[]} onClose={onClose} />
    ));
    // The full-viewport .recs-feed sits above the modal's background, so
    // real taps can never reach it; the ✕ is the close affordance. The
    // background therefore has NO click handler — this test documents
    // that contract.
    const modal = container.querySelector(".recs-modal")!;
    expect(modal).toBeTruthy();
    await fireEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("passes onImageTap through to cards", async () => {
    const recs = makeFeedOf(1, 500).illusts;
    const onImageTap = vi.fn();
    const { container } = render(() => (
      <RecsModal recs={recs} onClose={() => {}} onImageTap={onImageTap} />
    ));
    await fireEvent.click(container.querySelector(".feed-card .card-overlay")!);
    expect(onImageTap).toHaveBeenCalledWith(recs[0]);
  });
});
