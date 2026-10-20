package main

// Login-proxy boundary (review finding H1): the three root-relative
// continuation legs are gate-exempt, so the ONLY thing standing between
// the public Funnel and an unauthenticated request relay into Pixiv's
// login endpoints is the flow-cookie validation. These tests pin that
// boundary and the upstream concurrency bound.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeUpstreamCounter records how many requests reached the fake Pixiv
// host, so a rejection can be proved to be a rejection and not a
// quietly-forwarded request.
func fakePixivHits(t *testing.T) (map[string]string, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<html>upstream</html>"))
	}))
	t.Cleanup(up.Close)
	return map[string]string{
		"accounts": up.URL, "app": up.URL, "www": up.URL, "oauth": up.URL,
	}, &hits
}

// Before the fix, `serveProxy` only checked that the cookie was
// non-empty, so any caller could relay arbitrary POSTs into Pixiv's
// login/account endpoints with no gate cookie and no flow.
func TestAuthProxyRejectsForgedFlowCookie(t *testing.T) {
	targets, hits := fakePixivHits(t)
	withProxyTargets(t, targets)
	h := newServer(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20), "secret")

	paths := []string{
		"/api/auth/px/accounts/login",
		"/api/auth/px/app/web/v1/login",
		"/ajax/login",
		"/account-selected",
		"/web/v1/login",
		"/web/v1/users/auth/pixiv/start",
	}
	for _, path := range paths {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			req := httptest.NewRequest(method, path, strings.NewReader("username=x&password=y"))
			req.Header.Set("X-Api-Key", "secret")
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			// A fabricated, well-formed-looking value that was never
			// issued by /api/auth/pkce/start.
			req.AddCookie(&http.Cookie{Name: loginFlowCookie, Value: "Zm9yZ2VkLWZsb3ctaWQ"})
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != http.StatusForbidden {
				t.Fatalf("%s %s with forged flow cookie = %d, want 403", method, path, rr.Code)
			}
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("forged flow reached the upstream %d time(s) — the login legs are an open relay", n)
	}
}

// The same legs must work when the cookie names a live flow (the whole
// point of the proxy), and the flow must be usable repeatedly until the
// callback consumes it — peek() is non-consuming.
func TestAuthProxyAcceptsLiveFlowRepeatedly(t *testing.T) {
	targets, hits := fakePixivHits(t)
	withProxyTargets(t, targets)
	h := newServer(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20), "secret")
	flowID := startLoginFlow(t, h)

	for i := 0; i < 3; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/auth/px/accounts/login", nil)
		req.Header.Set("X-Api-Key", "secret")
		req.AddCookie(&http.Cookie{Name: loginFlowCookie, Value: flowID})
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("live flow leg %d = %d, want 200 (body: %s)", i+1, rr.Code, rr.Body.String())
		}
	}
	if n := hits.Load(); n != 3 {
		t.Fatalf("upstream saw %d requests, want 3", n)
	}
}

// The proxy legs must not let an unauthenticated caller stack unbounded
// TLS handshakes at Pixiv (the 502-storm condition upstreamSlots exists
// to prevent). Pinned as "never more than loginProxyMaxConcurrent in
// flight at the upstream".
func TestLoginProxyBoundsUpstreamConcurrency(t *testing.T) {
	release := make(chan struct{})
	var inFlight, maxInFlight atomic.Int64
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := inFlight.Add(1)
		for {
			old := maxInFlight.Load()
			if cur <= old || maxInFlight.CompareAndSwap(old, cur) {
				break
			}
		}
		<-release
		inFlight.Add(-1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(up.Close)
	withProxyTargets(t, map[string]string{
		"accounts": up.URL, "app": up.URL, "www": up.URL, "oauth": up.URL,
	})

	h := newServer(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20), "secret")
	flowID := startLoginFlow(t, h)

	const parallel = loginProxyMaxConcurrent * 2
	var wg sync.WaitGroup
	wg.Add(parallel)
	for i := 0; i < parallel; i++ {
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/api/auth/px/accounts/login", nil)
			req.Header.Set("X-Api-Key", "secret")
			req.AddCookie(&http.Cookie{Name: loginFlowCookie, Value: flowID})
			h.ServeHTTP(httptest.NewRecorder(), req)
		}()
	}

	// Wait until the cap is reached, then confirm it is never exceeded
	// while the slots are held.
	deadline := time.Now().Add(3 * time.Second)
	for inFlight.Load() < loginProxyMaxConcurrent && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := inFlight.Load(); got != loginProxyMaxConcurrent {
		t.Fatalf("in-flight upstream calls = %d, want exactly %d (slot gate not engaged)", got, loginProxyMaxConcurrent)
	}
	time.Sleep(100 * time.Millisecond)
	if got := maxInFlight.Load(); got > loginProxyMaxConcurrent {
		t.Fatalf("max in-flight upstream calls = %d, want <= %d", got, loginProxyMaxConcurrent)
	}

	close(release)
	wg.Wait()
}

// A request whose context is already canceled must not wait for a slot
// (and must not reach upstream): this is the shutdown/disconnect path.
func TestLoginProxyCanceledRequestSkipsUpstream(t *testing.T) {
	targets, hits := fakePixivHits(t)
	withProxyTargets(t, targets)
	h := newServer(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20), "secret")
	flowID := startLoginFlow(t, h)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodGet, "/api/auth/px/accounts/login", nil).WithContext(ctx)
	req.Header.Set("X-Api-Key", "secret")
	req.AddCookie(&http.Cookie{Name: loginFlowCookie, Value: flowID})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if n := hits.Load(); n != 0 {
		t.Fatalf("canceled request still hit upstream %d time(s)", n)
	}
	if rr.Code != http.StatusRequestTimeout && rr.Code != http.StatusBadGateway {
		t.Fatalf("canceled request = %d, want a clean refusal", rr.Code)
	}
}
