import { describe, it, expect } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { http, HttpResponse } from "msw";
import RelatedView from "./RelatedView";
import { makeFeedOf } from "../test-fixtures";
import { server } from "../test/msw/server";

// Real api/illust.getRelated -> request() -> MSW. The initial-load
// failure is a real 502 from a real request(), then the retry hits the
// endpoint again and succeeds — the same discrimination the module mock
// provided (reject once, resolve once), at the wire level.

const anchor = makeFeedOf(1, 900).illusts[0];

const baseProps = {
  anchor,
  zIndex: 50,
  depth: 1,
  maxDepth: 10,
  onClose: () => {},
  onCloseAll: () => {},
  onPush: () => {},
  onArtistTap: () => {},
  onTagsTap: () => {},
};

describe("RelatedView initial-load failure", () => {
  it("a failed initial load offers a retry button that recovers", async () => {
    let calls = 0;
    server.use(
      http.get("/api/illust/:id/related", () => {
        calls++;
        if (calls === 1) return new HttpResponse("upstream error\n", { status: 502 });
        return HttpResponse.json(makeFeedOf(3, 100));
      })
    );
    const { container } = render(() => <RelatedView {...baseProps} />);
    // The anchor renders immediately; the initial fetch fails.
    await waitFor(() =>
      expect(container.querySelector(".feed-sentinel .mode-pill")?.textContent).toContain(
        "Couldn't load related works"
      )
    );
    // Retry succeeds: the fresh works land, no error remains.
    await fireEvent.click(container.querySelector(".feed-sentinel .mode-pill")!);
    await waitFor(() =>
      expect(container.querySelectorAll(".feed-card").length).toBe(4) // anchor + 3
    );
    expect(container.querySelector(".feed-sentinel .mode-pill")).toBeNull();
  });
});
