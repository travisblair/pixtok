import { createSignal, Show, onMount } from "solid-js";
import { api } from "../api";
import BaseModal from "./BaseModal";

/**
 * Account screen: auth health for both pixiv surfaces + the in-app
 * Sign-in button. The button navigates to /api/auth/pkce/start — the
 * backend proxies pixiv's REAL login pages through our own origin
 * (cookies captured server-side), intercepts the OAuth callback, and
 * lands the user back here at ?auth=done. No Mac, no pasting, 2FA is
 * pixiv's own screens.
 */
export default function LoginScreen(props: { onClose: () => void }) {
  const [status, setStatus] = createSignal<{
    app_api: boolean;
    web_session: boolean;
  } | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [justLoggedIn, setJustLoggedIn] = createSignal(false);

  async function refresh() {
    setLoading(true);
    try {
      setStatus(await api.getAuthStatus());
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  onMount(() => {
    if (new URLSearchParams(window.location.search).get("auth") === "done") {
      setJustLoggedIn(true);
      // Drop the ?auth=done marker — it is a one-shot signal for this
      // screen, and reloading with it still in the URL would re-show
      // the "login complete" banner forever.
      window.history.replaceState(null, "", window.location.pathname);
    }
    void refresh();
  });

  return (
    <BaseModal
      title="Account"
      closeLabel="Close account"
      onClose={props.onClose}
      footer={
        <button type="button" onClick={props.onClose}>
          Done
        </button>
      }
    >
      <section>
        <Show when={justLoggedIn()}>
          <div class="auth-status ok">
            <span class="auth-dot" />
            Login complete — status updated below.
          </div>
        </Show>
        <Show
          when={status()?.app_api}
          fallback={
            <>
              <p class="hint">
                Sign in to Pixiv once — pixtok captures the session
                automatically and stays authenticated across reloads.
              </p>
              <a class="signin-btn" href="/api/auth/pkce/start">
                Sign in with Pixiv
              </a>
            </>
          }
        >
          <div class="auth-status ok">
            <span class="auth-dot" />
            Connected to Pixiv
          </div>
          <p class="hint">
            You're signed in. If a surface expires, re-authenticate
            below.
          </p>
          <a class="reauth-link" href="/api/auth/pkce/start">
            Re-authenticate
          </a>
        </Show>

        <h3>Status</h3>
        <Show when={loading()} fallback={null}>
          <div class="auth-status">Checking…</div>
        </Show>
        <Show when={status()}>
          <div class={status()!.app_api ? "auth-status ok" : "auth-status bad"}>
            <span class="auth-dot" />
            App API (Ranking, Discover, likes)
          </div>
          <div class={status()!.web_session ? "auth-status ok" : "auth-status bad"}>
            <span class="auth-dot" />
            Web session (Home, Newest, Illustrations)
          </div>
        </Show>
        <Show when={!status() && !loading()}>
          <div class="auth-status bad">
            <span class="auth-dot" />
            Backend unreachable
          </div>
        </Show>
        <button
          type="button"
          class="mode-pill"
          onClick={() => void refresh()}
          disabled={loading()}
        >
          ↻ Refresh status
        </button>
      </section>
    </BaseModal>
  );
}
