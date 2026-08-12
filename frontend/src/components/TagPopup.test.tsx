import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import TagPopup from "./TagPopup";
import { blockedTags, addBlockedTag } from "../store";
import { makeIllust } from "../test-fixtures";

describe("TagPopup", () => {
  it("renders every tag of the work as a chip", () => {
    const illust = makeIllust({
      id: 1,
      tags: [{ name: "swimsuit" }, { name: "cute" }, { name: "summer swimsuit" }],
    });
    const { container } = render(() => (
      <TagPopup illust={illust} onToggle={() => {}} onClose={() => {}} />
    ));
    const chips = [...container.querySelectorAll(".tag-chip")].map(
      (el) => el.textContent
    );
    expect(chips).toEqual(["#swimsuit", "#cute", "#summer swimsuit"]);
  });

  it("shows the Pixiv translation in small text under the original", () => {
    const illust = makeIllust({
      id: 1,
      tags: [
        { name: "水着", translated_name: "Swimsuit" },
        { name: "夏", translated_name: "" },
      ],
    });
    const { container } = render(() => (
      <TagPopup illust={illust} onToggle={() => {}} onClose={() => {}} />
    ));
    const chips = [...container.querySelectorAll(".tag-chip")];
    expect(chips[0].querySelector(".tag-chip-name")?.textContent).toBe("#水着");
    expect(chips[0].querySelector(".tag-chip-translation")?.textContent).toBe(
      "Swimsuit"
    );
    // empty translation is omitted
    expect(chips[1].querySelector(".tag-chip-translation")).toBeNull();
  });

  it("shows a fallback when the work has no tags", () => {
    const illust = makeIllust({ id: 1, tags: [] });
    const { getByText } = render(() => (
      <TagPopup illust={illust} onToggle={() => {}} onClose={() => {}} />
    ));
    expect(getByText("This work has no tags.")).toBeTruthy();
  });

  it("tapping a tag blocks it and reports the toggle", () => {
    const onToggle = vi.fn();
    const illust = makeIllust({ id: 1, tags: [{ name: "swimsuit" }] });
    const { container } = render(() => (
      <TagPopup illust={illust} onToggle={onToggle} onClose={() => {}} />
    ));

    fireEvent.click(container.querySelector(".tag-chip")!);

    expect(blockedTags()).toContain("swimsuit");
    expect(onToggle).toHaveBeenCalledWith("swimsuit", true);
  });

  it("tapping an already-blocked tag unblocks it", () => {
    addBlockedTag("swimsuit");
    const onToggle = vi.fn();
    const illust = makeIllust({ id: 1, tags: [{ name: "swimsuit" }] });
    const { container } = render(() => (
      <TagPopup illust={illust} onToggle={onToggle} onClose={() => {}} />
    ));

    const chip = container.querySelector(".tag-chip")!;
    expect(chip.className).toContain("blocked");
    fireEvent.click(chip);

    expect(blockedTags()).not.toContain("swimsuit");
    expect(onToggle).toHaveBeenCalledWith("swimsuit", false);
  });

  it("closes via the ✕ and Done buttons", () => {
    const onClose = vi.fn();
    const illust = makeIllust({ id: 1, tags: [{ name: "cute" }] });
    const { container } = render(() => (
      <TagPopup illust={illust} onToggle={() => {}} onClose={onClose} />
    ));

    fireEvent.click(container.querySelector(".modal-x")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
