package pixiv

// Credential-bearing requests must never follow redirects (review
// finding L7). Go strips Authorization/Cookie on a cross-host hop, but it
// does NOT strip custom headers (x-csrf-token) and it re-sends the
// request BODY on 307/308 — so a redirect from Pixiv's token endpoint
// would hand the refresh token / PKCE verifier to whichever host the
// Location names.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSharedClientDoesNotFollowCredentialRedirects(t *testing.T) {
	var reached atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(target.Close)

	for _, code := range []int{http.StatusTemporaryRedirect, http.StatusPermanentRedirect, http.StatusFound} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			reached.Store(0)
			origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, target.URL+"/steal", code)
			}))
			t.Cleanup(origin.Close)

			cl := newSharedHTTPClient()
			resp, err := cl.PostForm(origin.URL+"/auth/token", url.Values{"refresh_token": {"secret-token"}})
			if err != nil {
				t.Fatalf("POST: %v", err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != code {
				t.Fatalf("status = %d, want the redirect returned unfollowed (%d) body=%q", resp.StatusCode, code, body)
			}
			if n := reached.Load(); n != 0 {
				t.Fatalf("redirect followed: the credential-bearing request reached another host %d time(s)", n)
			}
		})
	}
}

// The redirect-validating proxy client must still follow an ALLOWED hop —
// the fix must not break image/next proxying (the bearer-token
// regression class: verify the legit path, not just the blocked one).
func TestValidatedClientStillFollowsAllowedRedirect(t *testing.T) {
	var hops atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops.Add(1)
		if r.URL.Path == "/final" {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Redirect(w, r, "/final", http.StatusFound)
	}))
	t.Cleanup(srv.Close)

	c := &Client{http: newSharedHTTPClient()}
	cl := c.newValidatedClient(func(string) bool { return true })

	resp, err := cl.Get(srv.URL + "/start")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("validated hop status = %d, want 200", resp.StatusCode)
	}
	if n := hops.Load(); n < 2 {
		t.Fatalf("validated redirect not followed (hops=%d)", n)
	}
	if !strings.HasSuffix(resp.Request.URL.Path, "/final") {
		t.Fatalf("final URL = %s", resp.Request.URL)
	}
}

// A disallowed hop is refused even on the validated client.
func TestValidatedClientRejectsDisallowedRedirect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://evil.example/", http.StatusFound)
	}))
	t.Cleanup(srv.Close)

	c := &Client{http: newSharedHTTPClient()}
	cl := c.newValidatedClient(func(raw string) bool { return strings.HasPrefix(raw, srv.URL) })

	if _, err := cl.Get(srv.URL + "/start"); err == nil {
		t.Fatal("redirect to a disallowed host was followed")
	}
}
