import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { http } from "msw";
import FollowButton from "./FollowButton";
import { json } from "../test/msw/handlers";
import { requestCount, server } from "../test/msw/server";

/**
 * Follow state is keyed to ONE user id, but ArtistView keeps a single
 * FollowButton instance across artist swaps (props.userId changes without
 * a remount). These tests pin the two consequences: the button must
 * re-key to the new id, and a response for the old id must never paint
 * the new artist's state.
 */

function Harness() {
  const [uid, setUid] = createSignal(101);
  return (
    <>
      <button data-testid="swap" type="button" onClick={() => setUid(202)}>
        swap
      </button>
      <FollowButton userId={uid()} label="Target" lazy={false} />
    </>
  );
}

function button(container: HTMLElement) {
  return container.querySelector(".artist-follow");
}

describe("FollowButton", () => {
  it("resets to the new artist on a userId swap; the tap targets that artist", async () => {
    server.use(
      http.get("/api/user/:id/followed", ({ params }) =>
        json({ followed: params.id === "101" })
      )
    );
    const { container } = render(() => <Harness />);
    // Artist 101 is followed — the header says so.
    await waitFor(() => expect(button(container)?.textContent).toBe("Following"));

    // Swap artists in place (no remount): the label must become B's.
    fireEvent.click(container.querySelector('[data-testid="swap"]')!);
    await waitFor(() => expect(button(container)?.textContent).toBe("Follow"));

    // The tap follows B. Pre-fix the stale `followed = true` made this
    // POST /unfollow for a user who was never followed.
    fireEvent.click(button(container)!);
    await waitFor(() => expect(requestCount("/api/user/202/follow")).toBe(1));
    expect(requestCount("/api/user/202/unfollow")).toBe(0);
    expect(requestCount("/api/user/101/follow")).toBe(0);
    expect(requestCount("/api/user/101/unfollow")).toBe(0);
  });

  it("ignores the previous artist's followed response after a swap", async () => {
    let release101!: () => void;
    const gate = new Promise<void>((r) => (release101 = r));
    server.use(
      http.get("/api/user/101/followed", async () => {
        await gate;
        return json({ followed: true });
      }),
      http.get("/api/user/202/followed", () => json({ followed: false }))
    );
    const { container } = render(() => <Harness />);
    // Artist 101's answer is still in flight when the user swaps to 202.
    fireEvent.click(container.querySelector('[data-testid="swap"]')!);
    await waitFor(() => expect(button(container)?.textContent).toBe("Follow"));

    // 101 answers "followed": the stale response must not flip 202's label.
    release101();
    await new Promise((r) => setTimeout(r, 30));
    expect(button(container)?.textContent).toBe("Follow");
  });
});
