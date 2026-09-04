import { createSignal, onMount, onCleanup, Show } from "solid-js";
import { logEvent, reportApiError } from "../api/client";
import { follow, getFollowed, unfollow } from "../api/follow";

/**
 * Follow toggle — used in the artist page header (full label, eager)
 * and on card artist rows (small icon variant, LAZY).
 *
 * Lazy fetch: follow state is requested only when the button's card
 * nears the viewport. A 60-work search render used to mount ~50 of
 * these at once — ~50 upstream /v1/user/detail calls per render, and
 * pixiv's app-API limiter answered with 429 storms that starved
 * bookmarks/related too (shared limiter). Now the fetch fires per card
 * as it scrolls into view; the backend single-flight cache collapses
 * repeats, and its 429 circuit breaker keeps a hot limiter from being
 * re-asked at all. Optimistic: the tap flips the state immediately and
 * the POST is authoritative; on failure the state reverts. Unknown
 * state hides the button entirely. Every mount + outcome leaves a
 * breadcrumb so a phone with no DevTools can explain why a button did
 * or didn't appear.
 */
export default function FollowButton(props: {
  userId: number;
  label?: string;
  small?: boolean;
  // Cards pass nothing (default lazy); the artist page header — always
  // visible on mount — passes lazy={false} and fetches immediately.
  lazy?: boolean;
}) {
  const [followed, setFollowed] = createSignal<boolean | null>(null);
  const [busy, setBusy] = createSignal(false);
  let anchorRef: HTMLSpanElement | undefined;
  let started = false;

  onMount(() => {
    logEvent("follow", "mount", { id: props.userId });
    if (props.lazy === false) {
      void load();
      return;
    }
    const root =
      anchorRef?.closest<HTMLElement>(".feed-container") ?? undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || started) return;
        started = true;
        io.disconnect();
        void load();
      },
      // One viewport of prefetch: the button is ready by the time the
      // card scrolls in, and off-screen cards never fetch at all.
      { root, rootMargin: "100% 0px 100% 0px" }
    );
    // Observe the CARD, not the anchor span: the span is
    // display:contents (layout-transparent) and generates no box, so
    // IntersectionObserver would never report it intersecting. The
    // span still works as a DOM anchor for closest() traversal.
    const target =
      anchorRef?.closest<HTMLElement>(".feed-card, .search-user-row") ??
      anchorRef;
    if (target) io.observe(target);
    onCleanup(() => io.disconnect());
  });

  async function load() {
    try {
      const res = await getFollowed(props.userId);
      logEvent("follow", "ok", { id: props.userId, followed: res.followed });
      setFollowed(res.followed);
    } catch (err) {
      reportApiError(err);
      logEvent("follow", "fail", {
        id: props.userId,
        err: err instanceof Error ? err.message : String(err),
      });
      setFollowed(null); // unknown — hide the button
    }
  }

  async function toggle(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (busy() || followed() === null) return;
    const next = !followed();
    setFollowed(next);
    setBusy(true);
    try {
      if (next) await follow(props.userId);
      else await unfollow(props.userId);
    } catch {
      setFollowed(!next); // revert — the tap was not authoritative
    } finally {
      setBusy(false);
    }
  }

  const button = (
    <Show when={followed() !== null}>
      <button
        type="button"
        class="artist-follow"
        classList={{ small: !!props.small, following: followed() === true }}
        onClick={toggle}
        aria-label={
          followed()
            ? `Unfollow ${props.label ?? ""}`.trim()
            : `Follow ${props.label ?? ""}`.trim()
        }
      >
        {followed() ? "Following" : "Follow"}
      </button>
    </Show>
  );

  // The lazy variant wraps the button in a layout-transparent anchor
  // (display: contents) so the IntersectionObserver has a stable
  // element to watch. The eager variant returns the button bare so
  // `.artist-view > .artist-follow` direct-child styling keeps working.
  if (props.lazy === false) return button;
  return (
    <span ref={anchorRef} style={{ display: "contents" }}>
      {button}
    </span>
  );
}
