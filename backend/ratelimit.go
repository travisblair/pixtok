package main

import (
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Per-tier limits. Deliberately generous: these exist to bound a runaway
// or compromised client, not to police a single user's browsing. Tune
// down only if server.log shows upstream pressure.
const (
	imagesPerMinute = 300 // /api/img — phone scrolls are bursty
	readsPerMinute  = 300 // /api/next, /api/search*, GETs — a fast strip browse
	// with the follow-state cache warm can pass 120/min in bursts
	mutationsPerMinute = 60  // POST/PUT/DELETE (likes, prefs, gate unlock)
	logsPerMinute      = 600 // /api/log breadcrumbs — instrumentation must never
	// starve real traffic (it once drained the mutations bucket and
	// 429'd LIKES: 88 breadcrumb POSTs in a render burst)
)

// bucket is a simple token bucket with a refill rate derived from the
// per-minute limit (limit/60 per second) and a burst capacity equal to
// the limit itself: a full minute of budget can be spent instantly, then
// it refills at the steady rate.
type bucket struct {
	mu      sync.Mutex
	tokens  float64
	last    time.Time
	perSec  float64
	burst   float64
	limiter *rateLimiter
}

// take consumes one token if available. Returns seconds until the next
// token on refusal (0 on success).
func (b *bucket) take() (bool, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.limiter.now()
	if b.last.IsZero() {
		b.last = now
	}
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens = math.Min(b.burst, b.tokens+elapsed*b.perSec)
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := (1 - b.tokens) / b.perSec
	return false, int(math.Ceil(wait))
}

type rateLimiter struct {
	images    bucket
	reads     bucket
	mutations bucket
	logs      bucket
	now       func() time.Time
}

func newRateLimiter(now func() time.Time) *rateLimiter {
	if now == nil {
		now = time.Now
	}
	rl := &rateLimiter{now: now}
	rl.images = bucket{tokens: imagesPerMinute, perSec: imagesPerMinute / 60.0, burst: imagesPerMinute, limiter: rl}
	rl.reads = bucket{tokens: readsPerMinute, perSec: readsPerMinute / 60.0, burst: readsPerMinute, limiter: rl}
	rl.mutations = bucket{tokens: mutationsPerMinute, perSec: mutationsPerMinute / 60.0, burst: mutationsPerMinute, limiter: rl}
	rl.logs = bucket{tokens: logsPerMinute, perSec: logsPerMinute / 60.0, burst: logsPerMinute, limiter: rl}
	return rl
}

func (rl *rateLimiter) tierFor(r *http.Request) *bucket {
	// The image route is exact-match "GET /api/img?url=..." — the old
	// prefix check ("/api/img/") never matched it, so every image
	// request metered into the shared reads bucket and the 300/min
	// images bucket was dead code (grid bursts then 429'd against the
	// 120/min reads tier, feeding the pagination storm). Keep the
	// prefix case for any future sub-routes.
	if r.URL.Path == "/api/img" || strings.HasPrefix(r.URL.Path, "/api/img/") {
		return &rl.images
	}
	// Breadcrumbs get their own bucket: diagnostics must never starve
	// the mutation tier they share a method with (likes 429'd).
	if r.URL.Path == "/api/log" {
		return &rl.logs
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return &rl.mutations
	}
	return &rl.reads
}

// middleware returns 429 + Retry-After when the request's tier bucket is
// empty. Placed outside the API-key gate so unauthenticated probes are
// throttled too.
func (rl *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := rl.tierFor(r)
		if ok, retry := b.take(); !ok {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retry))
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
