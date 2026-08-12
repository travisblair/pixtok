import { createSignal, Show } from "solid-js";
import { api } from "../api";

/**
 * App-owned password gate: the Funnel URL is public, so everything sits
 * behind one password. This screen shows until the backend unlocks
 * (POST /api/gate with the password; the backend sets an HttpOnly
 * session cookie).
 */
export default function GateScreen(props: { onUnlocked: () => void }) {
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(false);
    try {
      await api.gateUnlock(password());
      props.onUnlocked();
    } catch {
      setError(true);
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="gate-screen">
      <form class="gate-form" onSubmit={submit}>
        <div class="gate-logo">pixtok</div>
        <input
          type="password"
          placeholder="Password"
          value={password()}
          onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
          autocomplete="current-password"
          aria-label="Gate password"
        />
        <Show when={error()}>
          <div class="gate-error" aria-live="polite">
            Wrong password
          </div>
        </Show>
        <button type="submit" disabled={busy() || !password()}>
          Unlock
        </button>
      </form>
    </div>
  );
}
