import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { http, HttpResponse } from "msw";
import LoginScreen from "./LoginScreen";
import { server } from "../test/msw/server";

// Real api/auth.getAuthStatus -> request() -> MSW. The default handler
// reports both surfaces healthy; per-test variations override the wire
// response instead of a module mock.

describe("LoginScreen", () => {
  it("shows the connected banner plus both auth surfaces when authed", async () => {
    const { container } = render(() => <LoginScreen onClose={() => {}} />);
    await waitFor(() =>
      expect(container.querySelectorAll(".auth-status.ok").length).toBe(3)
    );
    expect(container.textContent).toContain("Connected to Pixiv");
    expect(container.textContent).toContain("App API");
    expect(container.textContent).toContain("Web session");
    // The primary CTA is now re-authentication, not a first sign-in.
    expect(container.querySelector(".signin-btn")).toBeNull();
    const reauth = container.querySelector(".reauth-link");
    expect(reauth?.getAttribute("href")).toBe("/api/auth/pkce/start");
  });

  it("marks a surface red when unhealthy", async () => {
    server.use(
      http.get("/api/auth/status", () =>
        HttpResponse.json({ app_api: true, web_session: false })
      )
    );
    const { container } = render(() => <LoginScreen onClose={() => {}} />);
    await waitFor(() =>
      expect(container.querySelectorAll(".auth-status.ok").length).toBe(2)
    );
    expect(container.querySelectorAll(".auth-status.bad").length).toBe(1);
  });

  it("shows backend-unreachable when the status call fails", async () => {
    server.use(
      http.get("/api/auth/status", () =>
        new HttpResponse("upstream error\n", { status: 502 })
      )
    );
    const { container } = render(() => <LoginScreen onClose={() => {}} />);
    await waitFor(() =>
      expect(container.textContent).toContain("Backend unreachable")
    );
  });

  it("refreshes the status on demand", async () => {
    // First load: fully authed. After the Refresh tap: both surfaces
    // report down — the screen must re-read the endpoint, not a cache.
    let calls = 0;
    server.use(
      http.get("/api/auth/status", () => {
        calls++;
        return HttpResponse.json(
          calls === 1
            ? { app_api: true, web_session: true }
            : { app_api: false, web_session: false }
        );
      })
    );
    const { container } = render(() => <LoginScreen onClose={() => {}} />);
    await waitFor(() =>
      expect(container.querySelectorAll(".auth-status.ok").length).toBe(3)
    );
    const refreshBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Refresh")
    )!;
    await fireEvent.click(refreshBtn);
    await waitFor(() =>
      expect(container.querySelectorAll(".auth-status.bad").length).toBe(2)
    );
  });

  it("shows the sign-in guidance and the proxied Sign-in link when logged out", async () => {
    server.use(
      http.get("/api/auth/status", () =>
        HttpResponse.json({ app_api: false, web_session: false })
      )
    );
    const { container } = render(() => <LoginScreen onClose={() => {}} />);
    await waitFor(() =>
      expect(container.textContent).toContain("Sign in to Pixiv once")
    );
    const btn = container.querySelector(".signin-btn");
    expect(btn?.getAttribute("href")).toBe("/api/auth/pkce/start");
  });
});
