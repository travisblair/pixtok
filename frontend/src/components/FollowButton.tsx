import { createSignal, onMount, Show } from "solid-js";
import { api, logEvent } from "../api";

/**
 * Follow toggle — used in the artist page header (full label) and on
 * card artist rows (small icon variant). Optimistic: the tap flips the
 * state immediately and the POST is authoritative; on failure the state
 * reverts. Per-mount fetch of /followed (follow state is cheap and
 * never bulk-seeded); unknown state hides the button entirely.
 * Every mount + outcome leaves a breadcrumb so a phone with no DevTools
 * can explain why a button did or didn't appear.
 */
export default function FollowButton(props: {
  userId: number;
  label?: string;
  small?: boolean;
}) {
  const [followed, setFollowed] = createSignal<boolean | null>(null);
  const [busy, setBusy] = createSignal(false);
  let btnRef: HTMLButtonElement | undefined;

  // After the state lands, report how the button actually PAINTED on
  // this device — the phone's follow buttons were fetching fine (mount
  // + ok breadcrumbs) yet stayed invisible, which is a paint problem
  // only the device can describe: rect, display, visibility, colors.
  function logRenderedState() {
    requestAnimationFrame(() => {
      const el = btnRef;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      logEvent("follow", "rendered", {
        id: props.userId,
        rect: {
          w: Math.round(r.width),
          h: Math.round(r.height),
          x: Math.round(r.x),
          y: Math.round(r.y),
        },
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        color: cs.color,
        bg: cs.backgroundColor,
      });
    });
  }

  onMount(() => {
    logEvent("follow", "mount", { id: props.userId });
    api
      .getFollowed(props.userId)
      .then((d) => {
        logEvent("follow", "ok", { id: props.userId, followed: d.followed });
        setFollowed(d.followed);
        logRenderedState();
      })
      .catch((err) => {
        logEvent("follow", "fail", {
          id: props.userId,
          err: err instanceof Error ? err.message : String(err),
        });
        setFollowed(null); // unknown — hide the button
      });
  });

  async function toggle(e: Event) {
    e.preventDefault();
    e.stopPropagation();
    if (busy() || followed() === null) return;
    const next = !followed();
    setFollowed(next);
    setBusy(true);
    try {
      if (next) await api.follow(props.userId);
      else await api.unfollow(props.userId);
    } catch {
      setFollowed(!next); // revert — the tap was not authoritative
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={followed() !== null}>
      <button
        ref={btnRef}
        type="button"
        class="follow-btn"
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
}
