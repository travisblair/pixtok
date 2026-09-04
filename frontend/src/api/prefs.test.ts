import { describe, it, expect, afterEach, vi } from "vitest";
import { api } from "./index";

// The prefs write queue (reviewer finding): rapid PUTs must apply in
// the order they were issued — ["a"] then ["a","b"] — never race.
describe("prefs write queue", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("serializes rapid preference writes (second waits for the first)", async () => {
    const bodies: string[] = [];
    let releaseFirst: (() => void) | null = null;
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(String(init.body));
      const respond = () =>
        new Response(JSON.stringify({ tags: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (bodies.length === 1) {
        return new Promise<Response>((resolve) => {
          releaseFirst = () => resolve(respond());
        });
      }
      return Promise.resolve(respond());
    }) as unknown as typeof fetch;

    const first = api.setBlockedTags(["a"]);
    const second = api.setBlockedTags(["a", "b"]);
    // The queued write reaches fetch on the next microtask — settle
    // that first, THEN assert the queue held the second write back.
    await Promise.resolve();
    expect(bodies).toEqual([JSON.stringify({ tags: ["a"] })]);
    releaseFirst!();
    await Promise.all([first, second]);
    expect(bodies).toEqual([
      JSON.stringify({ tags: ["a"] }),
      JSON.stringify({ tags: ["a", "b"] }),
    ]);
  });
});
