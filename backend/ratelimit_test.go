package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// rateLimit bounds a runaway or compromised client even when it holds
// valid gate credentials. Buckets are GLOBAL (the backend only ever sees
// 127.0.0.1 through the Vite proxy / Tailscale serve / Funnel — per-IP
// would collapse into one bucket anyway, and trusting X-Forwarded-For
// from a tunnel we can't verify is worse).
func TestRateLimitImagesTier(t *testing.T) {
	lim := newRateLimiter(nil)
	h := lim.middleware(noContentHandler())

	for i := 0; i < imagesPerMinute; i++ {
		rr := hitGet(h, "/api/img?url=https%3A%2F%2Fi.pximg.net%2Fimg%2F1.jpg")
		if rr.Code != http.StatusNoContent {
			t.Fatalf("request %d = %d, want 204", i+1, rr.Code)
		}
	}
	rr := hitGet(h, "/api/img?url=https%3A%2F%2Fi.pximg.net%2Fimg%2F1.jpg")
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("over-limit images request = %d, want 429", rr.Code)
	}
	if rr.Header().Get("Retry-After") == "" {
		t.Fatal("429 missing Retry-After header")
	}
}

func TestRateLimitTiersAreIndependent(t *testing.T) {
	lim := newRateLimiter(nil)
	h := lim.middleware(noContentHandler())

	// Exhaust the images bucket completely...
	for i := 0; i < imagesPerMinute; i++ {
		hitGet(h, "/api/img?url=https%3A%2F%2Fi.pximg.net%2Fimg%2F1.jpg")
	}
	// ...reads and mutations must be unaffected.
	if rr := hitGet(h, "/api/next?url=https%3A%2F%2Fapp-api.pixiv.net%2Fx"); rr.Code != http.StatusNoContent {
		t.Fatalf("read after image exhaustion = %d, want 204", rr.Code)
	}
	if rr := hitPost(h, "/api/illust/1/like"); rr.Code != http.StatusNoContent {
		t.Fatalf("mutation after image exhaustion = %d, want 204", rr.Code)
	}
}

func TestRateLimitMutationsTier(t *testing.T) {
	lim := newRateLimiter(nil)
	h := lim.middleware(noContentHandler())

	for i := 0; i < mutationsPerMinute; i++ {
		hitPost(h, "/api/illust/1/like")
	}
	if rr := hitPost(h, "/api/illust/1/like"); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("over-limit mutation = %d, want 429", rr.Code)
	}
}

func TestRateLimitRefillsOverTime(t *testing.T) {
	now := time.Now()
	lim := newRateLimiter(func() time.Time { return now })
	h := lim.middleware(noContentHandler())

	// Exhaust the mutations tier (60/min, refill 1/s).
	for i := 0; i < mutationsPerMinute; i++ {
		hitPost(h, "/api/illust/1/like")
	}
	if rr := hitPost(h, "/api/illust/1/like"); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 while empty, got %d", rr.Code)
	}
	now = now.Add(2 * time.Second)
	// Two tokens refilled — two requests succeed, the third trips again.
	if rr := hitPost(h, "/api/illust/1/like"); rr.Code != http.StatusNoContent {
		t.Fatalf("post-refill request = %d, want 204", rr.Code)
	}
	if rr := hitPost(h, "/api/illust/1/like"); rr.Code != http.StatusNoContent {
		t.Fatalf("second post-refill request = %d, want 204", rr.Code)
	}
	if rr := hitPost(h, "/api/illust/1/like"); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("third post-refill request = %d, want 429", rr.Code)
	}
}

func TestRateLimitRetryAfterIsSane(t *testing.T) {
	now := time.Now()
	lim := newRateLimiter(func() time.Time { return now })
	h := lim.middleware(noContentHandler())

	for i := 0; i < mutationsPerMinute; i++ {
		hitPost(h, "/api/illust/1/like")
	}
	rr := hitPost(h, "/api/illust/1/like")
	secs, err := strconv.Atoi(rr.Header().Get("Retry-After"))
	if err != nil || secs < 1 || secs > 60 {
		t.Fatalf("Retry-After = %q, want 1..60 seconds", rr.Header().Get("Retry-After"))
	}
}

func noContentHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
}

func hitGet(h http.Handler, path string) *httptest.ResponseRecorder {
	return do(h, http.MethodGet, path)
}

func hitPost(h http.Handler, path string) *httptest.ResponseRecorder {
	return do(h, http.MethodPost, path)
}

func do(h http.Handler, method, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://pixtok.test"+path, nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// Breadcrumbs get their own bucket: a render burst of log POSTs must
// never drain the mutation tier and 429 real traffic (likes).
func TestRateLimitLogTierIsIsolated(t *testing.T) {
	lim := newRateLimiter(nil)
	h := lim.middleware(noContentHandler())

	for i := 0; i < logsPerMinute; i++ {
		rr := hitPost(h, "/api/log")
		if rr.Code != http.StatusNoContent {
			t.Fatalf("log request %d = %d, want 204", i+1, rr.Code)
		}
	}
	// The log tier is exhausted — the log endpoint itself now 429s...
	if rr := hitPost(h, "/api/log"); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("log over budget = %d, want 429", rr.Code)
	}
	// ...but mutations are untouched.
	if rr := hitPost(h, "/api/illust/1/like"); rr.Code != http.StatusNoContent {
		t.Fatalf("like after log flood = %d, want 204", rr.Code)
	}
}

// hitGetXFF sends a GET as-if through the trusted local proxy: loopback
// RemoteAddr + the proxy's X-Forwarded-For client hop.
func hitGetXFF(h http.Handler, path, xff string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "http://pixtok.test"+path, nil)
	req.RemoteAddr = "127.0.0.1:5555"
	req.Header.Set("X-Forwarded-For", xff)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// Per-source buckets: one hostile client exhausts ITS budget, never the
// owner's (reviewer finding: global-only buckets let a single source
// deny the sole user).
func TestRateLimitPerSourceIsolation(t *testing.T) {
	lim := newRateLimiter(nil)
	h := lim.middleware(noContentHandler())

	img := "/api/img?url=https%3A%2F%2Fi.pximg.net%2Fimg%2F1.jpg"
	for i := 0; i < imagesPerMinute; i++ {
		if rr := hitGetXFF(h, img, "10.0.0.1"); rr.Code != http.StatusNoContent {
			t.Fatalf("source A request %d = %d, want 204", i+1, rr.Code)
		}
	}
	if rr := hitGetXFF(h, img, "10.0.0.1"); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("source A over budget = %d, want 429", rr.Code)
	}
	// Source B's budget is untouched by A's flood.
	if rr := hitGetXFF(h, img, "10.0.0.2"); rr.Code != http.StatusNoContent {
		t.Fatalf("source B after A's flood = %d, want 204", rr.Code)
	}
}

// X-Forwarded-For is trusted ONLY from a loopback peer (the local
// reverse proxy). A direct client can forge the header — its RemoteAddr
// is the key instead.
func TestRateLimitXFFTrustedOnlyFromLoopback(t *testing.T) {
	lim := newRateLimiter(nil)
	h := lim.middleware(noContentHandler())

	img := "/api/img?url=https%3A%2F%2Fi.pximg.net%2Fimg%2F1.jpg"
	// Same non-loopback RemoteAddr, different forged XFF values — they
	// must land in the SAME bucket.
	spoofA := httptest.NewRequest(http.MethodGet, "http://pixtok.test"+img, nil)
	spoofA.RemoteAddr = "203.0.113.9:1234"
	spoofA.Header.Set("X-Forwarded-For", "10.9.9.1")
	spoofB := httptest.NewRequest(http.MethodGet, "http://pixtok.test"+img, nil)
	spoofB.RemoteAddr = "203.0.113.9:1234"
	spoofB.Header.Set("X-Forwarded-For", "10.9.9.2")

	for i := 0; i < imagesPerMinute; i++ {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, spoofA)
		if rr.Code != http.StatusNoContent {
			t.Fatalf("spoofA request %d = %d, want 204", i+1, rr.Code)
		}
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, spoofB)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("forged XFF got its own bucket: %d, want 429 (RemoteAddr is the key)", rr.Code)
	}
}

// The global ceiling bounds the AGGREGATE of many distinct sources:
// each individual source stays under its own budget, but the fleet
// exhausts the process-wide bucket.
func TestRateLimitGlobalCeiling(t *testing.T) {
	lim := newRateLimiter(nil)
	h := lim.middleware(noContentHandler())

	img := "/api/img?url=https%3A%2F%2Fi.pximg.net%2Fimg%2F1.jpg"
	// globalMultiplier distinct sources, each at its full per-source
	// budget — the aggregate fills the global ceiling exactly.
	for s := 0; s < globalMultiplier; s++ {
		xff := fmt.Sprintf("10.1.0.%d", s+1)
		for i := 0; i < imagesPerMinute; i++ {
			if rr := hitGetXFF(h, img, xff); rr.Code != http.StatusNoContent {
				t.Fatalf("source %d request %d = %d, want 204 (per-source should hold)", s+1, i+1, rr.Code)
			}
		}
	}
	// A fresh source passes ITS bucket but trips the global ceiling.
	if rr := hitGetXFF(h, img, fmt.Sprintf("10.1.0.%d", globalMultiplier+1)); rr.Code != http.StatusTooManyRequests {
		t.Fatalf("over-global request = %d, want 429", rr.Code)
	}
}
