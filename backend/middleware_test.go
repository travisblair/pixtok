package main

// Middleware order + log-hardening regressions (review findings H2, M3).
//
// The order is load-bearing twice over: origin rejects must consume a
// rate-limit token (or they are a free journal-write amplifier), and the
// API-key gate must come AFTER the origin check (a cross-origin mutation
// is refused regardless of key). Both are pinned as behavior here, not
// by reading the source.

import (
	"bytes"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// captureLog redirects the standard logger into a buffer for the duration
// of a test and returns an accessor.
func captureLog(t *testing.T) func() string {
	t.Helper()
	var mu sync.Mutex
	var buf bytes.Buffer
	oldOut := log.Writer()
	oldFlags := log.Flags()
	log.SetOutput(writerFunc(func(p []byte) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		return buf.Write(p)
	}))
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(oldOut)
		log.SetFlags(oldFlags)
	})
	return func() string {
		mu.Lock()
		defer mu.Unlock()
		return buf.String()
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// productionChain builds the real chain shape around a probe route, with
// the real API-key gate and password gate. Returns the handler plus the
// gate so a test can seed state.
func productionChain(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/probe", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	g, err := newGate("correct horse battery staple", true)
	if err != nil {
		t.Fatalf("newGate: %v", err)
	}
	return middlewareChain(apiKeyGate("secret", g.middleware(mux)), newRateLimiter(nil))
}

// Origin rejects must spend a mutation token: originCheck sits INSIDE the
// rate limiter. Before the fix the 61st cross-origin POST still answered
// 403 because originCheck ran before the limiter ever looked at it.
func TestOriginRejectsConsumeRateLimitTokens(t *testing.T) {
	h := productionChain(t)

	post := func() int {
		req := httptest.NewRequest(http.MethodPost, "/api/probe", strings.NewReader("{}"))
		req.RemoteAddr = "203.0.113.7:5555"
		req.Header.Set("Origin", "https://evil.example")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr.Code
	}

	for i := 0; i < mutationsPerMinute; i++ {
		if code := post(); code != http.StatusForbidden {
			t.Fatalf("request %d: cross-origin POST = %d, want 403", i+1, code)
		}
	}
	if code := post(); code != http.StatusTooManyRequests {
		t.Fatalf("after %d cross-origin rejects = %d, want 429 — originCheck ran outside the rate limiter", mutationsPerMinute, code)
	}
}

// originCheck must run before apiKeyGate: a cross-origin mutation is
// refused as a CSRF attempt (403), never as a missing key (401).
func TestOriginCheckPrecedesAPIKeyGate(t *testing.T) {
	h := productionChain(t)

	req := httptest.NewRequest(http.MethodPost, "/api/probe", strings.NewReader("{}"))
	req.RemoteAddr = "203.0.113.8:5555"
	req.Header.Set("Origin", "https://evil.example")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("cross-origin POST without API key = %d, want 403 (originCheck before apiKeyGate)", rr.Code)
	}

	// Same request with a valid key still 403s — the origin check is not
	// a key check.
	req = httptest.NewRequest(http.MethodPost, "/api/probe", strings.NewReader("{}"))
	req.RemoteAddr = "203.0.113.8:5555"
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("X-Api-Key", "secret")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("cross-origin POST with key = %d, want 403", rr.Code)
	}

	// And a keyless same-origin mutation reaches the key gate (401), not
	// the origin check.
	req = httptest.NewRequest(http.MethodPost, "/api/probe", strings.NewReader("{}"))
	req.Host = "app.example"
	req.RemoteAddr = "203.0.113.8:5555"
	req.Header.Set("Origin", "https://app.example")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("same-origin POST without key = %d, want 401", rr.Code)
	}
}

// A decoded newline in the path must not be able to forge journal lines
// (M3), and the line must stay bounded (H2).
func TestLogLineEscapesInjectedNewline(t *testing.T) {
	out := captureLog(t)
	h := middlewareChain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), newRateLimiter(nil))

	req := httptest.NewRequest(http.MethodGet,
		"/api/x%0A2026/10/19%20ERROR%20forged%20journal%20line", nil)
	req.RemoteAddr = "203.0.113.9:5555"
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	got := out()
	if strings.Count(got, "\n") != 1 {
		t.Fatalf("log output spans %d lines, want exactly 1:\n%s", strings.Count(got, "\n"), got)
	}
	if strings.Contains(got, "\n2026/10/19") {
		t.Fatalf("forged journal line survived:\n%s", got)
	}
	// The newline is neutralized (replaced with a space by
	// sanitizeLogText), so the forged text stays INSIDE the quoted field
	// instead of starting a new record.
	if !strings.Contains(got, `"/api/x 2026/10/19 ERROR forged journal line"`) {
		t.Fatalf("path was not quoted as a single field: %q", got)
	}
}

// A 100 KB path is refused with 414 and never produces a 100 KB line.
func TestOverLongPathGets414AndBoundedLog(t *testing.T) {
	out := captureLog(t)
	h := middlewareChain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler reached for an over-long path")
	}), newRateLimiter(nil))

	req := httptest.NewRequest(http.MethodGet, "/"+strings.Repeat("a", 100_000), nil)
	req.RemoteAddr = "203.0.113.10:5555"
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusRequestURITooLong {
		t.Fatalf("over-long path = %d, want 414", rr.Code)
	}
	got := out()
	if len(got) > 4*maxLogFieldBytes {
		t.Fatalf("log output is %d bytes for one request, want bounded (~%d)", len(got), 4*maxLogFieldBytes)
	}
}

// The origin WARN line must be bounded and its path escaped: this is the
// pre-gate, pre-token surface the review measured at 100 KB per line.
func TestOriginRejectLogIsBoundedAndEscaped(t *testing.T) {
	out := captureLog(t)
	h := originCheck(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("cross-origin mutation reached the handler")
	}))

	req := httptest.NewRequest(http.MethodPost,
		"/api/x%0AERROR%20forged", strings.NewReader("{}"))
	req.Host = "app.example"
	req.Header.Set("Origin", "https://"+strings.Repeat("e", 100_000)+".example")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("cross-origin = %d, want 403", rr.Code)
	}
	got := out()
	if strings.Count(got, "\n") != 1 {
		t.Fatalf("WARN line spans %d lines:\n%s", strings.Count(got, "\n"), got)
	}
	if len(got) > 4*maxLogFieldBytes {
		t.Fatalf("WARN line is %d bytes, want bounded (~%d)", len(got), 4*maxLogFieldBytes)
	}
}

// The server config must cap headers — the 1 MB default is what let a
// single request carry a ~1 MB Origin into the log path.
func TestServerMaxHeaderBytesIsSmall(t *testing.T) {
	srv := newHTTPServer("127.0.0.1:0", http.NotFoundHandler())
	if srv.MaxHeaderBytes == 0 || srv.MaxHeaderBytes > 64<<10 {
		t.Fatalf("MaxHeaderBytes = %d, want a small explicit cap", srv.MaxHeaderBytes)
	}
	if srv.WriteTimeout != serverWriteTimeout || srv.ReadTimeout != serverReadTimeout {
		t.Fatalf("timeouts changed: read=%v write=%v", srv.ReadTimeout, srv.WriteTimeout)
	}
	if srv.WriteTimeout <= 0 || srv.IdleTimeout <= 0 {
		t.Fatalf("unbounded timeouts: %+v", srv)
	}
}

// logField is the shared cap: short values pass through untouched, long
// ones are truncated on a rune boundary, control bytes never survive.
func TestLogFieldCapsAndSanitizes(t *testing.T) {
	if got := logField("short"); got != "short" {
		t.Fatalf("logField(short) = %q", got)
	}
	long := strings.Repeat("é", maxLogFieldBytes) // 2 bytes per rune
	got := logField(long)
	if len(got) > maxLogFieldBytes+len("…") {
		t.Fatalf("logField len = %d, want <= %d", len(got), maxLogFieldBytes+len("…"))
	}
	for _, r := range got {
		if r == '\uFFFD' {
			t.Fatalf("truncation split a rune: %q", got)
		}
	}
	if got := logField("a\nb\r\tc"); strings.ContainsAny(got, "\n\r\t") {
		t.Fatalf("control bytes survived: %q", got)
	}
}

func TestMiddlewareChainKeepsRateLimiterOutsideOriginCheck(t *testing.T) {
	// A cross-origin GET is rate-limited but origin-exempt; exhausting the
	// reads bucket must 429 rather than reach the handler.
	h := middlewareChain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), newRateLimiter(nil))

	deadline := time.Now().Add(2 * time.Second)
	for i := 0; i < readsPerMinute+1; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/probe", nil)
		req.RemoteAddr = "203.0.113.11:5555"
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if i == readsPerMinute {
			if rr.Code != http.StatusTooManyRequests {
				t.Fatalf("read %d = %d, want 429", i+1, rr.Code)
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("rate-limit loop took too long")
		}
	}
}
