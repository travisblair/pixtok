import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { http, HttpResponse } from "msw";
import GateScreen from "./GateScreen";
import { requestCount, requestsTo, server } from "../test/msw/server";

// Real api/auth.gateUnlock -> request() -> MSW. The default handler
// accepts any well-formed POST /api/gate; failure cases override below.
// Assertions stay at the network level: a gate request must reach the
// real endpoint with the typed password (the module-mock era asserted
// gateUnlock("hunter2"); the wire form is the same contract, minus the
// mock).

describe("GateScreen", () => {
  it("unlocks on the correct password and fires onUnlocked", async () => {
    const onUnlocked = vi.fn();
    const { container } = render(() => <GateScreen onUnlocked={onUnlocked} />);

    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "hunter2" } });
    fireEvent.click(container.querySelector("button")!);

    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(requestCount("/api/gate")).toBe(1);
    expect(await requestsTo("/api/gate")[0].json()).toEqual({
      password: "hunter2",
    });
  });

  it("shows the error and clears the password when the unlock is rejected", async () => {
    // Backend contract: a wrong password is 401 "wrong password".
    server.use(
      http.post("/api/gate", () =>
        new HttpResponse("wrong password\n", { status: 401 })
      )
    );
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
    let releaseGate!: () => void;
    const pending = new Promise<void>((res) => {
      releaseGate = res;
    });
    server.use(
      http.post("/api/gate", async () => {
        await pending;
        return HttpResponse.json({ ok: true });
      })
    );
    const onUnlocked = vi.fn();
    const { container } = render(() => <GateScreen onUnlocked={onUnlocked} />);

    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "hunter2" } });
    fireEvent.click(container.querySelector("button")!);
    fireEvent.click(container.querySelector("button")!); // double-tap
    expect(requestCount("/api/gate")).toBe(1);

    releaseGate();
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
  });
});
