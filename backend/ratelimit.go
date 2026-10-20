package main

import (
	"fmt"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Per-tier limits (per SOURCE). Deliberately generous: these exist to
// bound a runaway or compromised client, not to police a single user's
// browsing. Tune down only if server.log shows upstream pressure.
const (
	imagesPerMinute = 300 // /api/img — phone scrolls are bursty
	readsPerMinute  = 300 // /api/next, /api/search*, GETs — a fast strip browse
	// with the follow-state cache warm can pass 120/min in bursts
	mutationsPerMinute = 60  // POST/PUT/DELETE (likes, prefs, gate unlock)
	logsPerMinute      = 600 // /api/log breadcrumbs — instrumentation must never
	// starve real traffic (it once drained the mutations bucket and
	// 429'd LIKES: 88 breadcrumb POSTs in a render burst)
)

// globalMultiplier: the process-wide ceiling for each tier sits at this
// multiple of the per-source limit. Per-source buckets stop ONE hostile
// client from eating the shared budget and 429ing the owner (reviewer
// finding: global-only buckets let any single source deny the sole
// user); the global ceiling stops a FLEET of distinct sources doing the
// same in aggregate.
const globalMultiplier = 4

// maxSources bounds the per-source bucket table (one entry per distinct
// client). On overflow a slot is evicted arbitrarily — losing a bucket
// is cheaper than growing unbounded under a spoofed-source flood, and
// the global ceiling still bounds the aggregate.
const maxSources = 256

// maxSourceTableBytes bounds the table by MEMORY, not just entry count:
// 256 entries of long hostile keys would otherwise pin megabytes on a
// Pi with a 120 MB memory cap. Keys are capped at maxSourceKeyBytes by
// sourceKey (an IP string), so this is a belt-and-braces bound against
// future key sources.
const maxSourceTableBytes = 16 << 10

// maxSourceKeyBytes is the longest key sourceKey will produce. A longer
// X-Forwarded-For element is not an IP and is rejected outright rather
// than truncated into a colliding key.
const maxSourceKeyBytes = 64

// maxXFFBytes caps how much of X-Forwarded-For is parsed at all. The
// header can be as large as MaxHeaderBytes; the RIGHTMOST maxXFFBytes
// bytes are kept when it is longer, so the element the proxy appended
// (the one we key on) always survives intact.
const maxXFFBytes = 256

type tier int

const (
	tierImages tier = iota
	tierReads
	tierMutations
	tierLogs
)

// bucket is a simple token bucket with a refill rate derived from the
// per-minute limit (limit/60 per second) and a burst capacity equal to
// the limit itself: a full minute of budget can be spent instantly, then
// it refills at the steady rate.
type bucket struct {
	mu     sync.Mutex
	tokens float64
	last   time.Time
	perSec float64
	burst  float64
	now    func() time.Time
}

func newBucket(perMinute int, now func() time.Time) bucket {
	return bucket{
		tokens: float64(perMinute),
		perSec: float64(perMinute) / 60.0,
		burst:  float64(perMinute),
		now:    now,
	}
}

// take consumes one token if available. Returns seconds until the next
// token on refusal (0 on success).
func (b *bucket) take() (bool, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
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

// sourceTiers is one client's private set of buckets.
type sourceTiers struct {
	buckets [4]bucket
}

func newSourceTiers(now func() time.Time) *sourceTiers {
	st := &sourceTiers{}
	st.buckets[tierImages] = newBucket(imagesPerMinute, now)
	st.buckets[tierReads] = newBucket(readsPerMinute, now)
	st.buckets[tierMutations] = newBucket(mutationsPerMinute, now)
	st.buckets[tierLogs] = newBucket(logsPerMinute, now)
	return st
}

func (st *sourceTiers) bucket(t tier) *bucket { return &st.buckets[t] }

// sourceTable maps client source keys to their private buckets.
type sourceTable struct {
	mu      sync.Mutex
	entries map[string]*sourceTiers
	bytes   int // total bytes of retained keys
}

func (st *sourceTable) forSource(key string, now func() time.Time) *sourceTiers {
	st.mu.Lock()
	defer st.mu.Unlock()
	if t, ok := st.entries[key]; ok {
		return t
	}
	// Bounded by BOTH entry count and retained key bytes. Arbitrary
	// eviction (bounded table, single-user app): the evicted source gets
	// a fresh bucket, which only matters to someone exhausting the table
	// itself — and the global ceiling still bounds them.
	for len(st.entries) > 0 &&
		(len(st.entries) >= maxSources || st.bytes+len(key) > maxSourceTableBytes) {
		for k := range st.entries {
			delete(st.entries, k)
			st.bytes -= len(k)
			break
		}
	}
	st.entries[key] = newSourceTiers(now)
	st.bytes += len(key)
	return st.entries[key]
}

// peerHost returns the address of the immediate peer (no port).
func peerHost(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}

// isLoopbackHost reports whether host is a loopback literal or name.
func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// sourceKey identifies the CLIENT behind the request. The backend only
// ever sees loopback through Vite/tailscale serve/Funnel, so the real
// source arrives in X-Forwarded-For — but ONLY from a loopback peer is
// that header trusted (a direct client can forge it; its RemoteAddr is
// the key instead).
//
// The RIGHTMOST element is used, and it must parse as an IP. A proxy
// that APPENDS the peer it saw (Go's httputil.ReverseProxy does:
// "prior, clientIP") leaves caller-supplied text to the left; keying on
// the first element let a caller rotate the header per request and mint
// unlimited buckets (per-source limits never engage, and the shared
// global ceiling 429s the owner). Anything that does not parse falls back
// to the peer address — one shared bucket, never a free pass.
func sourceKey(r *http.Request) string {
	peer := peerHost(r.RemoteAddr)
	if !isLoopbackHost(peer) {
		return peer
	}
	xff := r.Header.Get("X-Forwarded-For")
	if len(xff) > maxXFFBytes {
		// Keep the rightmost bytes: that is where the trusted last hop
		// appended its element. Cutting the left can only mangle
		// elements we would never key on.
		xff = xff[len(xff)-maxXFFBytes:]
	}
	parts := strings.Split(xff, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		cand := strings.TrimSpace(parts[i])
		if cand == "" || len(cand) > maxSourceKeyBytes {
			continue
		}
		if ip := net.ParseIP(cand); ip != nil {
			return ip.String()
		}
	}
	return peer
}

type rateLimiter struct {
	now    func() time.Time
	global [4]bucket
	source sourceTable
}

func newRateLimiter(now func() time.Time) *rateLimiter {
	if now == nil {
		now = time.Now
	}
	rl := &rateLimiter{now: now}
	rl.source.entries = make(map[string]*sourceTiers)
	for i := range rl.global {
		var perMin int
		switch tier(i) {
		case tierImages:
			perMin = imagesPerMinute
		case tierReads:
			perMin = readsPerMinute
		case tierMutations:
			perMin = mutationsPerMinute
		default:
			perMin = logsPerMinute
		}
		rl.global[i] = newBucket(perMin*globalMultiplier, now)
	}
	return rl
}

func (rl *rateLimiter) tierFor(r *http.Request) tier {
	// The image route is exact-match "GET /api/img?url=..." — the old
	// prefix check ("/api/img/") never matched it, so every image
	// request metered into the shared reads bucket and the 300/min
	// images bucket was dead code (grid bursts then 429'd against the
	// 120/min reads tier, feeding the pagination storm). Keep the
	// prefix case for any future sub-routes.
	if r.URL.Path == "/api/img" || strings.HasPrefix(r.URL.Path, "/api/img/") {
		return tierImages
	}
	// Breadcrumbs get their own bucket: diagnostics must never starve
	// the mutation tier they share a method with (likes 429'd).
	if r.URL.Path == "/api/log" {
		return tierLogs
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return tierMutations
	}
	return tierReads
}

// middleware returns 429 + Retry-After when the request's per-source
// bucket or the global ceiling for its tier is empty. Placed outside the
// API-key gate so unauthenticated probes are throttled too.
func (rl *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t := rl.tierFor(r)
		// Per-source first: one hostile client must not exhaust a
		// shared budget and deny the owner (reviewer finding).
		if ok, retry := rl.source.forSource(sourceKey(r), rl.now).bucket(t).take(); !ok {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retry))
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		// Global ceiling second: an aggregate of distinct sources is
		// bounded by the process-wide budget.
		if ok, retry := rl.global[t].take(); !ok {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retry))
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
