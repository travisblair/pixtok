import { createSignal, onMount, Show } from "solid-js";
import { api } from "../api";

/**
 * Follow toggle — used in the artist page header (full label) and on
 * card artist rows (small icon variant). Optimistic: the tap flips the
 * state immediately and the POST is authoritative; on failure the state
 * reverts. Per-mount fetch of /followed (follow state is cheap and
 * never bulk-seeded); unknown state hides the button entirely.
 */
export default function FollowButton(props: {
  userId: number;
  label?: string;
  small?: boolean;
}) {
  const [followed, setFollowed] = createSignal<boolean | null>(null);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    api
      .getFollowed(props.userId)
      .then((d) => setFollowed(d.followed))
      .catch(() => setFollowed(null)); // unknown — hide the button
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
