package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// writeDeadlineSpy captures per-response write deadlines as they are set
// through http.ResponseController. Unwrap mirrors statusRecorder so the
// production recorder stack (logRequests) is exercised rather than
// bypassed — a missing Unwrap is exactly the bug that made SetWriteDeadline
// fail live (see main.go).
type writeDeadlineSpy struct {
	http.ResponseWriter
	mu        sync.Mutex
	deadlines []time.Time
}

func (s *writeDeadlineSpy) SetWriteDeadline(t time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deadlines = append(s.deadlines, t)
	return nil
}

func (s *writeDeadlineSpy) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *writeDeadlineSpy) recorded() []time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Time(nil), s.deadlines...)
}

// assertWriteDeadline checks that exactly one deadline was set, for
// approximately start+budget. Two seconds of slack covers scheduling
// between the harness timestamp and the handler's time.Now().
func assertWriteDeadline(t *testing.T, spy *writeDeadlineSpy, start, end time.Time, budget time.Duration) {
	t.Helper()
	got := spy.recorded()
	if len(got) != 1 {
		t.Fatalf("SetWriteDeadline calls = %d, want exactly 1", len(got))
	}
	lo := start.Add(budget - 2*time.Second)
	hi := end.Add(budget + 2*time.Second)
	if got[0].Before(lo) || got[0].After(hi) {
		t.Fatalf("write deadline = %v (%v after handler start), want ≈ start+%v (between %v and %v)",
			got[0], got[0].Sub(start), budget, lo, hi)
	}
}

// TestSlowHandlersSetWriteDeadline pins finding M2: every handler whose
// sequential upstream chain can outlive the server's 15s WriteTimeout
// must override its own write deadline, with the documented budget.
func TestSlowHandlersSetWriteDeadline(t *testing.T) {
	cases := []struct {
		name   string
		method string
		path   string
		body   string
		budget time.Duration
	}{
		// refresh (30s) + webGet (30s) + 10s margin.
		{"auth status", http.MethodGet, "/api/auth/status", "", 70 * time.Second},
		// GetStreet retries once on 400/401: 2 × 30s + 10s.
		{"street", http.MethodPost, "/api/street", `{}`, 70 * time.Second},
		// 2 pools × 6 default pages × 30s + 10s = 370s, clamped to 90s.
		{"bookmark ids default pages", http.MethodGet, "/api/bookmarks/ids", "", 90 * time.Second},
		// 2 pools × 1 page × 30s + 10s = 70s, under the clamp.
		{"bookmark ids one page", http.MethodGet, "/api/bookmarks/ids?pages=1", "", 70 * time.Second},
		// One 30s upstream call + 10s margin.
		{"search artworks", http.MethodGet, "/api/search/artworks?word=x", "", 40 * time.Second},
		{"search users", http.MethodGet, "/api/search/users?nick=x", "", 40 * time.Second},
		{"next", http.MethodGet, "/api/next?url=" + url.QueryEscape("https://app-api.pixiv.net/v1/illust/recommended"), "", 40 * time.Second},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := logRequests(newServer(&fakeAPI{}, newImageCache(time.Hour, 4, 1<<20), "secret"))
			spy := &writeDeadlineSpy{ResponseWriter: httptest.NewRecorder()}

			var body *strings.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			}
			var req *http.Request
			if body != nil {
				req = httptest.NewRequest(tc.method, tc.path, body)
			} else {
				req = httptest.NewRequest(tc.method, tc.path, nil)
			}
			req.Header.Set("X-Api-Key", "secret")

			start := time.Now()
			h.ServeHTTP(spy, req)
			end := time.Now()

			assertWriteDeadline(t, spy, start, end, tc.budget)
		})
	}
}

// TestLoginCallbackWriteDeadlineCoversFullChain covers the callback
// separately: it needs a live PKCE flow entry, and its budget must span
// BOTH sequential upstream calls (ExchangePkce, then ScrapeCsrfFor) plus
// the redirect — a 15s deadline would cut the response after the token
// rotation had already been persisted.
func TestLoginCallbackWriteDeadlineCoversFullChain(t *testing.T) {
	h := logRequests(newServer(&fakeAPI{}, newImageCache(time.Hour, 4, 1<<20), "secret"))

	// Start a real flow so the callback finds a live pkce entry, and take
	// the flow cookie the start route plants.
	startRR := httptest.NewRecorder()
	startReq := httptest.NewRequest(http.MethodGet, "/api/auth/pkce/start", nil)
	startReq.Header.Set("X-Api-Key", "secret")
	h.ServeHTTP(startRR, startReq)
	if startRR.Code != http.StatusFound {
		t.Fatalf("/api/auth/pkce/start = %d, want 302", startRR.Code)
	}
	var flow *http.Cookie
	for _, c := range startRR.Result().Cookies() {
		if c.Name == loginFlowCookie {
			flow = c
		}
	}
	if flow == nil {
		t.Fatalf("start response did not set %s", loginFlowCookie)
	}

	spy := &writeDeadlineSpy{ResponseWriter: httptest.NewRecorder()}
	req := httptest.NewRequest(http.MethodGet,
		"/api/auth/px/app/web/v1/users/auth/pixiv/callback?code=one-time", nil)
	req.Header.Set("X-Api-Key", "secret")
	req.AddCookie(flow)
	// PHPSESSID forces the second sequential upstream call (ScrapeCsrfFor)
	// that the budget has to cover.
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "sess"})

	start := time.Now()
	h.ServeHTTP(spy, req)
	end := time.Now()

	// ExchangePkce (30s) + ScrapeCsrfFor/webGet (30s) + 10s margin.
	assertWriteDeadline(t, spy, start, end, 70*time.Second)

	rr, ok := spy.ResponseWriter.(*httptest.ResponseRecorder)
	if !ok {
		t.Fatalf("underlying writer = %T, want *httptest.ResponseRecorder", spy.ResponseWriter)
	}
	if rr.Code != http.StatusFound {
		t.Fatalf("callback status = %d, want 302", rr.Code)
	}
	if loc := rr.Header().Get("Location"); loc != "/?auth=done" {
		t.Fatalf("callback Location = %q, want /?auth=done", loc)
	}
}
