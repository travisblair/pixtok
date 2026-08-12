import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import RankingSelector from "./RankingSelector";

describe("RankingSelector", () => {
  it("renders the full mode set when content=all", () => {
    const { container } = render(() => (
      <RankingSelector content="all" mode="day" onChange={() => {}} />
    ));
    const pills = [...container.querySelectorAll(".mode-pill")].map(
      (b) => b.textContent
    );
    expect(pills).toEqual([
      "Daily",
      "Weekly",
      "Monthly",
      "Rookie",
      "Original",
      "AI",
      "Male",
      "Female",
    ]);
  });

  it("swaps to the R-18 variants when content=r18", () => {
    const { container } = render(() => (
      <RankingSelector content="r18" mode="day_r18" onChange={() => {}} />
    ));
    const pills = [...container.querySelectorAll(".mode-pill")].map(
      (b) => b.textContent
    );
    expect(pills).toEqual(["Daily", "Weekly", "Male", "Female"]);
  });

  it("fires onChange with the tapped mode", async () => {
    const onChange = vi.fn();
    const { getByText } = render(() => (
      <RankingSelector content="all" mode="day" onChange={onChange} />
    ));
    await fireEvent.click(getByText("Weekly"));
    expect(onChange).toHaveBeenCalledWith("week");
  });

  it("marks the active mode pill", () => {
    const { getByText } = render(() => (
      <RankingSelector content="r18" mode="week_r18" onChange={() => {}} />
    ));
    expect(getByText("Weekly").className).toContain("active");
    expect(getByText("Daily").className).not.toContain("active");
  });
});
