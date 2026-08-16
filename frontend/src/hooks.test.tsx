import { describe, it, expect, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "@solidjs/testing-library";
import { useFeedSentinel } from "./hooks";

/**
 * useFeedSentinel wiring tests.
 *
 * The MockIntersectionObserver (test-setup) reports every observed
 * element as intersecting IMMEDIATELY on observe() — which faithfully
 * models the real-browser behaviour of a re-observed sentinel that is
 * still inside the root margin delivering an initial callback. That
 * initial callback is the mechanism behind the grid-mode 429 storm, so
 * these tests pin the re-subscribe/fire semantics down.
 */

function Harness(props: {
  canLoad: () => boolean;
  onFire: () => void;
  margin?: () => string;
}) {
  let sentinelRef: HTMLDivElement | undefined;
  useFeedSentinel(
    () => sentinelRef,
    props.canLoad,
    props.onFire,
    props.margin ?? (() => "2400px")
  );
  return <div ref={sentinelRef} data-testid="sentinel" />;
}

describe("useFeedSentinel", () => {
  it("fires loadMore when the sentinel observes intersecting and canLoad is true", () => {
    const onFire = vi.fn();
    render(() => <Harness canLoad={() => true} onFire={onFire} />);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire when canLoad is false", () => {
    const onFire = vi.fn();
    render(() => <Harness canLoad={() => false} onFire={onFire} />);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("re-subscribes when canLoad flips false → true (re-observe fires)", () => {
    const [canLoad, setCanLoad] = createSignal(false);
    const onFire = vi.fn();
    render(() => <Harness canLoad={canLoad} onFire={onFire} />);
    expect(onFire).not.toHaveBeenCalled();

    // Flip loadable: the effect re-subscribes and the mock observer's
    // initial callback fires once. This is the re-fire that the error
    // guards in App/ArtistView/Search/Related pin down — without them,
    // a failed load (loading flips) re-fires forever.
    setCanLoad(true);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-fire when canLoad flips false (error guard path)", () => {
    const [canLoad, setCanLoad] = createSignal(true);
    const onFire = vi.fn();
    render(() => <Harness canLoad={canLoad} onFire={onFire} />);
    expect(onFire).toHaveBeenCalledTimes(1);

    // The observer disconnects on the flip and never re-fires until the
    // screen says loadable again.
    setCanLoad(false);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("tracks the margin accessor: a margin change re-subscribes", () => {
    const [margin, setMargin] = createSignal("2400px");
    const onFire = vi.fn();
    render(() => (
      <Harness canLoad={() => true} onFire={onFire} margin={margin} />
    ));
    expect(onFire).toHaveBeenCalledTimes(1);

    // Grid → strip (or vice versa): the accessor is read inside the
    // effect, so a different margin re-subscribes with the new value.
    setMargin("400px");
    expect(onFire).toHaveBeenCalledTimes(2);
  });
});
