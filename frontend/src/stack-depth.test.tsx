import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { http } from "msw";
import App from "./App";
import { maxStackDepth } from "./store";
import { json } from "./test/msw/handlers";
import { requestsTo, server } from "./test/msw/server";

// The Settings → Stack depth box: seeded from the loaded pref, applies on
// change (no save button, like the view-mode pills), normalizes 0/empty to
// the default (10) and clamps the 1..30 range before the PUT.
describe("stack depth setting", () => {
  async function openSettings(container: HTMLElement) {
    await fireEvent.click(container.querySelector(".burger-pill")!);
    await fireEvent.click(
      [...container.querySelectorAll(".drawer-item")].find((b) =>
        b.textContent?.includes("Settings")
      )!
    );
    await waitFor(() =>
      expect(container.querySelector(".modal-dialog")).toBeTruthy()
    );
  }

  it("seeds from the store, normalizes 0 → default, and persists the change", async () => {
    server.use(
      http.get("/api/prefs/max-stack-depth", () => json({ value: 12 }))
    );
    const { container } = render(() => <App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(30)
    );
    await waitFor(() => expect(maxStackDepth()).toBe(12));

    await openSettings(container);
    const input = container.querySelector(
      '[data-testid="max-depth-input"]'
    ) as HTMLInputElement;
    // Seeded from the store, numeric, bounded 1..30.
    expect(input.value).toBe("12");
    expect(input.type).toBe("number");
    expect(input.min).toBe("1");
    expect(input.max).toBe("30");
    // The 0-shorthand is documented next to the box.
    expect(container.textContent).toContain("0 = default (10)");

    // 0 applies the default immediately and is persisted as 10.
    await fireEvent.input(input, { target: { value: "0" } });
    await fireEvent.blur(input);
    expect(maxStackDepth()).toBe(10);
    expect(input.value).toBe("10");
    await vi.waitFor(() => {
      expect(
        requestsTo("/api/prefs/max-stack-depth").some(
          (r) => r.method === "PUT"
        )
      ).toBe(true);
    });
    const put = requestsTo("/api/prefs/max-stack-depth").find(
      (r) => r.method === "PUT"
    )!;
    expect(await put.json()).toEqual({ value: 10 });

    // Out-of-range input clamps at the hard bound before it is persisted.
    await fireEvent.input(input, { target: { value: "99" } });
    await fireEvent.blur(input);
    expect(maxStackDepth()).toBe(30);
    expect(input.value).toBe("30");
    await vi.waitFor(() => {
      expect(
        requestsTo("/api/prefs/max-stack-depth").filter(
          (r) => r.method === "PUT"
        ).length
      ).toBeGreaterThanOrEqual(2);
    });
  });
});
