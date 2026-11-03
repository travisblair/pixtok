package main

// Proxy response hygiene (review finding L8): connection-scoped headers
// must not be relayed, an oversized JSON body must fail loudly instead of
// being served truncated, and a truncated stream must at least be logged.

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// proxyGet drives one gate-exempt login-proxy navigation with a live flow
// cookie and the dev API key (the gate still guards /api in dev mode).
func proxyGet(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := withFlowCookie(t, h, httptest.NewRequest(http.MethodGet, path, nil))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestLoginProxyStripsHopByHopHeaders(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Connection", "X-Hop")
		h.Set("X-Hop", "must-not-escape")
		h.Set("Keep-Alive", "timeout=5")
		h.Set("Proxy-Authenticate", "Basic realm=upstream")
		h.Set("TE", "trailers")
		h.Set("X-Keep", "end-to-end")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("<html>ok</html>"))
	}))
	t.Cleanup(up.Close)
	withProxyTargets(t, map[string]string{"accounts": up.URL, "app": up.URL, "www": up.URL})

	h := newServer(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20), "secret")
	rr := proxyGet(t, h, "/api/auth/px/accounts/login")

	if rr.Code != http.StatusOK {
		t.Fatalf("proxy = %d, want 200", rr.Code)
	}
	for _, k := range []string{"Connection", "X-Hop", "Keep-Alive", "Proxy-Authenticate", "TE"} {
		if v := rr.Header().Get(k); v != "" {
			t.Errorf("hop-by-hop header %s leaked to the client (%q)", k, v)
		}
	}
	if got := rr.Header().Get("X-Keep"); got != "end-to-end" {
		t.Errorf("end-to-end header dropped: X-Keep=%q", got)
	}
}

func TestLoginProxyOversizedJSONIs502(t *testing.T) {
	// A JSON body one byte over the rewrite cap. Before the fix the
	// proxy buffered exactly cap bytes, set Content-Length to the
	// truncated length and served invalid JSON as 200.
	payload := bytes.Repeat([]byte("a"), loginProxyRewriteCap+1)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(payload)
	}))
	t.Cleanup(up.Close)
	withProxyTargets(t, map[string]string{"accounts": up.URL, "app": up.URL, "www": up.URL})

	h := newServer(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20), "secret")
	rr := proxyGet(t, h, "/api/auth/px/app/api/whatever")

	if rr.Code != http.StatusBadGateway {
		t.Fatalf("oversized JSON body = %d, want 502 (body %d bytes)", rr.Code, rr.Body.Len())
	}
	if rr.Body.Len() > 1024 {
		t.Fatalf("502 carried %d bytes of upstream body", rr.Body.Len())
	}
}

func TestLoginProxyTruncatedStreamIsLogged(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), loginProxyStreamCap+1)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write(payload)
	}))
	t.Cleanup(up.Close)
	withProxyTargets(t, map[string]string{"accounts": up.URL, "app": up.URL, "www": up.URL})

	out := captureLog(t)
	h := newServer(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20), "secret")
	rr := proxyGet(t, h, "/api/auth/px/accounts/login")

	if rr.Code != http.StatusOK {
		t.Fatalf("streamed body = %d, want 200", rr.Code)
	}
	if rr.Body.Len() != loginProxyStreamCap {
		t.Fatalf("streamed %d bytes, want the %d-byte cap", rr.Body.Len(), loginProxyStreamCap)
	}
	if got := out(); !strings.Contains(got, "stream truncated at the") {
		t.Fatalf("truncated stream not logged: %q", got)
	}
}
