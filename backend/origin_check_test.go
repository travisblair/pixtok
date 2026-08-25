package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// originCheck is a CSRF belt-and-suspenders layer on top of the existing
// defenses (POST-only mutations, JSON content-type on the gate unlock,
// SameSite=Lax). Browsers attach Origin to cross-origin state changes —
// if present, its host must match the request Host.
func TestOriginCheckBlocksCrossOriginMutation(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	h := originCheck(inner)

	req := httptest.NewRequest(http.MethodPost, "https://pixtok.example/api/illust/1/like", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("cross-origin POST = %d, want 403", rr.Code)
	}
}

func TestOriginCheckAllowsSameOriginMutation(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	h := originCheck(inner)

	req := httptest.NewRequest(http.MethodPost, "https://pixtok.example/api/illust/1/like", nil)
	req.Header.Set("Origin", "https://pixtok.example")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("same-origin POST = %d, want 204", rr.Code)
	}
}

// Ports are not part of the origin-security property here: the Vite dev
// proxy rewrites Host to :8080 while the browser's Origin says :5173,
// and serve/Funnel terminate on their own ports. Same hostname must
// pass, different hostname must fail (regression from the live 403).
func TestOriginCheckIgnoresPort(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	h := originCheck(inner)

	// Host: localhost:8080 (rewritten by the dev proxy), Origin:
	// http://localhost:5173 (the browser's view) — same hostname.
	req := httptest.NewRequest(http.MethodPost, "http://localhost:8080/api/street", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("same-hostname different-port POST = %d, want 204", rr.Code)
	}

	// Same port, different hostname — still rejected.
	req = httptest.NewRequest(http.MethodPost, "http://localhost:8080/api/street", nil)
	req.Header.Set("Origin", "http://evil.example:8080")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("different-hostname same-port POST = %d, want 403", rr.Code)
	}
}

func TestOriginCheckAllowsNoOrigin(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	h := originCheck(inner)

	// curl and other non-browser clients send no Origin header — CSRF is
	// a browser-only attack vector, so these pass.
	req := httptest.NewRequest(http.MethodPost, "https://pixtok.example/api/illust/1/like", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("origin-less POST = %d, want 204", rr.Code)
	}
}

func TestOriginCheckIgnoresReads(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	h := originCheck(inner)

	// GETs are read-only and never mutating — cross-origin reads are not
	// CSRF, so they pass through regardless of Origin.
	req := httptest.NewRequest(http.MethodGet, "https://pixtok.example/api/feed", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("cross-origin GET = %d, want 204", rr.Code)
	}
}

func TestOriginCheckAllowsPreflight(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	h := originCheck(inner)

	// Preflights never carry state — exempt them; the actual mutating
	// POST that follows is still checked.
	req := httptest.NewRequest(http.MethodOptions, "https://pixtok.example/api/illust/1/like", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("preflight = %d, want 204", rr.Code)
	}
}

// The proxied pixiv login flow is exempt from the same-host check (found
// live Aug 24: the post-redirect bouncer loads Cloudflare's challenge
// script, whose opaque-origin POSTs got 403'd and killed the flow AFTER
// a successful login). These surfaces are flow-cookie gated + CSP-exempt;
// cross-origin POSTs there must pass through to the proxy.
func TestOriginCheckExemptsLoginProxyPaths(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	h := originCheck(inner)

	for _, path := range []string{
		"/ajax/login",
		"/ajax/login/passkey/generate-options",
		"/api/auth/px/accounts/post-redirect",
		"/cdn-cgi/challenge-platform/scripts/precursor/main.js",
		"/account-selected", // pixiv's "continue using account" POST (Origin: null)
	} {
		req := httptest.NewRequest(http.MethodPost, "https://pixtok.example"+path, nil)
		req.Header.Set("Origin", "https://evil.example.com") // opaque/challenge origins
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusNoContent {
			t.Errorf("POST %s with foreign Origin = %d, want pass-through 204", path, rr.Code)
		}
	}

	// Non-login paths keep the protection.
	req := httptest.NewRequest(http.MethodPost, "https://pixtok.example/api/prefs/blocked-tags", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("cross-origin POST outside login flow = %d, want 403", rr.Code)
	}
}
