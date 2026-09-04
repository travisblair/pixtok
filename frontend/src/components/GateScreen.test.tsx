import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import GateScreen from "./GateScreen";

vi.mock("../api/auth", () => ({
  gateUnlock: vi.fn(),
}));
vi.mock("../api/client", () => ({ reportApiError: vi.fn() }));

import * as auth from "../api/auth";
const mockedApi = auth as unknown as { gateUnlock: ReturnType<typeof vi.fn> };

beforeEach(() => {
  mockedApi.gateUnlock.mockReset().mockResolvedValue({ ok: true });
});

describe("GateScreen", () => {
  it("unlocks on the correct password and fires onUnlocked", async () => {
    const onUnlocked = vi.fn();
    const { container } = render(() => <GateScreen onUnlocked={onUnlocked} />);

    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "hunter2" } });
    fireEvent.click(container.querySelector("button")!);

    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(mockedApi.gateUnlock).toHaveBeenCalledWith("hunter2");
  });

  it("shows the error and clears the password when the unlock is rejected", async () => {
    mockedApi.gateUnlock.mockRejectedValue(new Error("401: wrong password"));
    const onUnlocked = vi.fn();
    const { container } = render(() => <GateScreen onUnlocked={onUnlocked} />);

    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "nope" } });
    fireEvent.click(container.querySelector("button")!);

    await waitFor(() =>
      expect(container.querySelector(".gate-error")).toBeTruthy()
    );
    expect(container.textContent).toContain("Wrong password");
    expect(input.value).toBe("");
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("does not submit while a request is in flight", async () => {
    let resolveUnlock: (v: { ok: boolean }) => void = () => {};
    mockedApi.gateUnlock.mockReturnValue(
      new Promise((res) => {
        resolveUnlock = res;
      })
    );
    const onUnlocked = vi.fn();
    const { container } = render(() => <GateScreen onUnlocked={onUnlocked} />);

    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "hunter2" } });
    fireEvent.click(container.querySelector("button")!);
    fireEvent.click(container.querySelector("button")!); // double-tap
    expect(mockedApi.gateUnlock).toHaveBeenCalledTimes(1);

    resolveUnlock({ ok: true });
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
  });
});
