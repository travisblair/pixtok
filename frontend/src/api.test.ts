import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "./api";

function mockFetch(response: { ok: boolean; status: number; body?: string }) {
  const fn = vi.fn(async () => ({
    ok: response.ok,
    status: response.status,
    statusText: response.ok ? "OK" : "Error",
    text: async () => response.body ?? "",
    json: async () => JSON.parse(response.body ?? "{}"),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.request", () => {
  it("returns parsed JSON on success", async () => {
    mockFetch({ ok: true, status: 200, body: '{"illusts":[]}' });
    const data = await api.getTop("all");
    expect(data).toEqual({ illusts: [] });
  });

  it("throws with status and body on failure", async () => {
    mockFetch({ ok: false, status: 502, body: "upstream error" });
    await expect(api.getTop("all")).rejects.toThrow("502: upstream error");
  });
});

describe("api.normalizeIds", () => {
  it("converts string ids to numbers", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: '{"illusts":[{"id":"123","user":{"id":"45"}}]}',
    });
    const data = await api.getTop("all");
    expect((data as { illusts: Array<{ id: number; user: { id: number } }> }).illusts[0].id).toBe(123);
    expect((data as { illusts: Array<{ id: number; user: { id: number } }> }).illusts[0].user.id).toBe(45);
  });

  it("leaves unsafe integers as exact strings (no lossy Number)", async () => {
    mockFetch({
      ok: true,
      status: 200,
      // 9007199254740993 = 2^53 + 1 — Number() would silently round it.
      body: '{"illusts":[{"id":"9007199254740993","user":{"id":"1"}}]}',
    });
    const data = await api.getTop("all");
    expect((data as { illusts: Array<{ id: unknown }> }).illusts[0].id).toBe("9007199254740993");
  });
});

describe("api.getTop", () => {
  it("sends the mode as a query param", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: '{"illusts":[]}' });
    await api.getTop("r18");
    expect(fn).toHaveBeenCalledWith(
      "/api/top?mode=r18",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("defaults to mode=day", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: '{"illusts":[]}' });
    await api.getTop();
    expect(fn).toHaveBeenCalledWith(
      "/api/top?mode=day",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe("api.like / api.unlike", () => {
  it("POSTs and resolves on ok", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: '{"ok":true}' });
    await expect(api.like(123)).resolves.toEqual({ ok: true });
    expect(fn).toHaveBeenCalledWith(
      "/api/illust/123/like",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws when the server rejects — the heart must revert", async () => {
    mockFetch({ ok: false, status: 401, body: "Unauthorized" });
    await expect(api.like(123)).rejects.toThrow(/401/);
    await expect(api.unlike(123)).rejects.toThrow(/401/);
  });
});

describe("api.getRelated", () => {
  it("hits the related route with the illust id", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: '{"illusts":[]}' });
    await api.getRelated(42);
    expect(fn).toHaveBeenCalledWith(
      "/api/illust/42/related",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe("api.getWorkRecs", () => {
  it("hits the per-work recs route with the liked illust id", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: '{"illusts":[]}' });
    await api.getWorkRecs(123);
    expect(fn).toHaveBeenCalledWith(
      "/api/illust/123/recs",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe("api.getUserIllusts", () => {
  it("hits the user illusts route", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: '{"illusts":[]}' });
    await api.getUserIllusts(7);
    expect(fn).toHaveBeenCalledWith(
      "/api/user/7/illusts",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

describe("api.getUgoiraMeta", () => {
  it("hits the ugoira_meta route", async () => {
    const fn = mockFetch({
      ok: true,
      status: 200,
      body: '{"error":false,"body":{"src":"z","originalSrc":"o","mime_type":"image/jpeg","frames":[]}}',
    });
    const data = await api.getUgoiraMeta(9);
    expect(fn).toHaveBeenCalledWith(
      "/api/illust/9/ugoira_meta",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(data.body.frames).toEqual([]);
  });
});

describe("api id normalization", () => {
  it("coerces string illust + user ids to numbers", async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: '{"illusts":[{"id":"111","user":{"id":"222"}},{"id":333,"user":{"id":444}}]}',
    });
    const data = await api.getTop();
    expect(data.illusts[0].id).toBe(111);
    expect(data.illusts[0].user.id).toBe(222);
    expect(data.illusts[1].id).toBe(333);
  });
});

describe("api.getStreet", () => {
  it("POSTs to /api/street with the nextParams cursor as the body", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: '{"illusts":[]}' });
    await api.getStreet('{"page":2}');
    expect(fn).toHaveBeenCalledWith(
      "/api/street",
      expect.objectContaining({
        method: "POST",
        body: '{"page":2}',
      })
    );
  });

  it("sends an empty JSON body for the first page", async () => {
    const fn = mockFetch({ ok: true, status: 200, body: '{"illusts":[]}' });
    await api.getStreet("");
    expect(fn).toHaveBeenCalledWith(
      "/api/street",
      expect.objectContaining({ method: "POST", body: "{}" })
    );
  });
});
