import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import NavigationDrawer from "./NavigationDrawer";

describe("NavigationDrawer", () => {
  it("starts closed", () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <NavigationDrawer feedType="home" onChange={onChange} />
    ));
    expect(container.querySelector(".drawer.open")).toBeNull();
  });

  it("opens on burger click and closes on ✕", async () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <NavigationDrawer feedType="home" onChange={onChange} />
    ));
    await fireEvent.click(container.querySelector(".burger-pill")!);
    expect(container.querySelector(".drawer.open")).not.toBeNull();
    await fireEvent.click(container.querySelector(".drawer-close")!);
    expect(container.querySelector(".drawer.open")).toBeNull();
  });

  it("selecting an item calls onChange and closes the drawer", async () => {
    const onChange = vi.fn();
    const { getByText, container } = render(() => (
      <NavigationDrawer feedType="home" onChange={onChange} />
    ));
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Discover"));
    expect(onChange).toHaveBeenCalledWith("recommended");
    expect(container.querySelector(".drawer.open")).toBeNull();
  });

  it("exposes the full feed list: Home, Newest, Illustrations, Ranking, Discover", async () => {
    const onChange = vi.fn();
    const { getByText, container } = render(() => (
      <NavigationDrawer feedType="home" onChange={onChange} />
    ));
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("Newest"));
    expect(onChange).toHaveBeenCalledWith("newest");
    await fireEvent.click(getByText("Illustrations"));
    expect(onChange).toHaveBeenCalledWith("top");
    await fireEvent.click(getByText("Ranking"));
    expect(onChange).toHaveBeenCalledWith("illustrations");
    await fireEvent.click(getByText("Discover"));
    expect(onChange).toHaveBeenCalledWith("recommended");
  });

  it("settings item calls onSettings and closes the drawer", async () => {
    const onChange = vi.fn();
    const onSettings = vi.fn();
    const { getByText, container } = render(() => (
      <NavigationDrawer feedType="home" onChange={onChange} onSettings={onSettings} />
    ));
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(getByText("⚙ Settings"));
    expect(onSettings).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".drawer.open")).toBeNull();
  });

  it("hides the settings item when no handler is provided", async () => {
    const onChange = vi.fn();
    const { queryByText, container } = render(() => (
      <NavigationDrawer feedType="home" onChange={onChange} />
    ));
    await fireEvent.click(container.querySelector(".burger-pill")!);
    expect(queryByText("⚙ Settings")).toBeNull();
  });

  it("marks the active feed type", () => {
    const onChange = vi.fn();
    const { getByText } = render(() => (
      <NavigationDrawer feedType="recommended" onChange={onChange} />
    ));
    expect(getByText("Discover").className).toContain("active");
  });
});
