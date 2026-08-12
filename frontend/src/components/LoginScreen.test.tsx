import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import LoginScreen from "./LoginScreen";

vi.mock("../api", () => ({
  api: {
    getAuthStatus: vi.fn(),
  },
}));

import { api } from "../api";
const mockedApi = api as unknown as { getAuthStatus: ReturnType<typeof vi.fn> };

beforeEach(() => {
  mockedApi.getAuthStatus
    .mockReset()
    .mockResolvedValue({ app_api: true, web_session: true });
});

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
    mockedApi.getAuthStatus.mockResolvedValue({
      app_api: true,
      web_session: false,
    });
    const { container } = render(() => <LoginScreen onClose={() => {}} />);
    await waitFor(() =>
      expect(container.querySelectorAll(".auth-status.ok").length).toBe(2)
    );
    expect(container.querySelectorAll(".auth-status.bad").length).toBe(1);
  });

  it("shows backend-unreachable when the status call fails", async () => {
    mockedApi.getAuthStatus.mockRejectedValue(new Error("down"));
    const { container } = render(() => <LoginScreen onClose={() => {}} />);
    await waitFor(() =>
      expect(container.textContent).toContain("Backend unreachable")
    );
  });

  it("refreshes the status on demand", async () => {
    const { container } = render(() => <LoginScreen onClose={() => {}} />);
    await waitFor(() =>
      expect(container.querySelectorAll(".auth-status.ok").length).toBe(3)
    );
    mockedApi.getAuthStatus.mockResolvedValue({
      app_api: false,
      web_session: false,
    });
    const refreshBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Refresh")
    )!;
    await fireEvent.click(refreshBtn);
    await waitFor(() =>
      expect(container.querySelectorAll(".auth-status.bad").length).toBe(2)
    );
  });

  it("shows the sign-in guidance and the proxied Sign-in link when logged out", async () => {
    mockedApi.getAuthStatus.mockResolvedValue({
      app_api: false,
      web_session: false,
    });
    const { container } = render(() => <LoginScreen onClose={() => {}} />);
    await waitFor(() =>
      expect(container.textContent).toContain("Sign in to Pixiv once")
    );
    const btn = container.querySelector(".signin-btn");
    expect(btn?.getAttribute("href")).toBe("/api/auth/pkce/start");
  });
});
