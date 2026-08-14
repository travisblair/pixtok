package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// Adversarial tests for the PKCE store (reviewer ask: expiry, single-use,
// eviction cap, concurrent consumption) and the login proxy's method and
// cookie allowlists.

func TestPkceStoreExpiry(t *testing.T) {
	s := newPkceStore()
	s.put("state1", "verifier1")
	// Rewind the entry's expiry to the past and confirm take refuses.
	s.mu.Lock()
	e := s.entries["state1"]
	e.expires = time.Now().Add(-time.Minute)
	s.entries["state1"] = e
	s.mu.Unlock()
	if _, ok := s.take("state1"); ok {
		t.Fatal("expired PKCE entry was accepted")
	}
	if _, ok := s.take("state1"); ok {
		t.Fatal("expired entry still present after take (not single-use)")
	}
}

func TestPkceStoreSingleUse(t *testing.T) {
	s := newPkceStore()
	s.put("state1", "v")
	if _, ok := s.take("state1"); !ok {
		t.Fatal("first take failed")
	}
	// Replay of the same state must fail.
	if _, ok := s.take("state1"); ok {
		t.Fatal("PKCE state replay was accepted (must be single-use)")
	}
}

func TestPkceStoreEvictionCap(t *testing.T) {
	s := newPkceStore()
	for i := 0; i < pkceMaxEntries+5; i++ {
		s.put(randomState(t), "v")
	}
	if len(s.entries) > pkceMaxEntries {
		t.Fatalf("pkce store grew to %d entries, cap is %d", len(s.entries), pkceMaxEntries)
	}
}

func TestPkceStoreConcurrentTake(t *testing.T) {
	s := newPkceStore()
	s.put("race", "v")
	var wg sync.WaitGroup
	wins := 0
	var mu sync.Mutex
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, ok := s.take("race"); ok {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("concurrent takes: %d winners, want exactly 1", wins)
	}
}

func randomState(t *testing.T) string {
	t.Helper()
	s, err := randomB64(16)
	if err != nil {
		t.Fatalf("randomB64: %v", err)
	}
	return s
}

// ── Login proxy method allowlist ───────────────────────────────────────

func TestAuthProxyRejectsNonListedMethods(t *testing.T) {
	_, targets := fakePixivUpstream(t)
	withProxyTargets(t, targets)
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	for _, m := range []string{"PUT", "PATCH", "DELETE", "CONNECT", "TRACE"} {
		req := withFlowCookie(httptest.NewRequest(m, "/api/auth/px/accounts/login", nil))
		req.Header.Set("X-Api-Key", "secret")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s through login proxy = %d, want 405", m, rr.Code)
		}
	}
	// GET and POST still pass the method gate (200 from the fake upstream).
	for _, m := range []string{http.MethodGet, http.MethodPost} {
		req := withFlowCookie(httptest.NewRequest(m, "/api/auth/px/accounts/login", nil))
		req.Header.Set("X-Api-Key", "secret")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code == http.StatusMethodNotAllowed {
			t.Errorf("%s through login proxy = 405, want pass", m)
		}
	}
}

// ── Login proxy cookie allowlist ───────────────────────────────────────

func TestAuthProxyForwardsOnlyPixivCookies(t *testing.T) {
	// Dedicated upstream that records the Cookie header it receives.
	var lastCookie string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastCookie = r.Header.Get("Cookie")
		w.WriteHeader(200)
	}))
	t.Cleanup(up.Close)
	withProxyTargets(t, map[string]string{
		"accounts": up.URL, "app": up.URL, "www": up.URL,
	})

	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	req := withFlowCookie(httptest.NewRequest(http.MethodGet, "/api/auth/px/accounts/login", nil))
	req.Header.Set("X-Api-Key", "secret")
	req.Header.Set("Cookie",
		"PHPSESSID=123_abcdef0123456789abcdef; device_token=devtok; "+
			"pixtok_login=shouldnotleave; pixtok_gate=alsonot; tracker=evil")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("proxy = %d: %s", rr.Code, rr.Body.String())
	}
	if lastCookie == "" {
		t.Fatal("upstream saw no cookie header")
	}
	for _, forbidden := range []string{"tracker", "pixtok_login", "pixtok_gate"} {
		if contains(lastCookie, forbidden) {
			t.Fatalf("non-pixiv cookie leaked upstream: %q", lastCookie)
		}
	}
	if !contains(lastCookie, "PHPSESSID") || !contains(lastCookie, "device_token") {
		t.Fatalf("pixiv session cookies missing upstream: %q", lastCookie)
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
