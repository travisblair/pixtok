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
