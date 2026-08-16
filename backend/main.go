package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/travisblair/pixtok/pixiv"
)

type cacheEntry struct {
	data        []byte
	contentType string
	expiresAt   time.Time
}

type imageCache struct {
	mu         sync.RWMutex
	items      map[string]cacheEntry
	ttl        time.Duration
	maxEntries int
	maxBytes   int64
	totalBytes int64
}

const (
	maxEntryBytes = 5 << 20 // skip caching bodies larger than this
)

func newImageCache(ttl time.Duration, maxEntries int, maxBytes int64) *imageCache {
	c := &imageCache{
		items:      make(map[string]cacheEntry),
		ttl:        ttl,
		maxEntries: maxEntries,
		maxBytes:   maxBytes,
	}
	go c.reapLoop()
	return c
}

func (c *imageCache) get(key string) ([]byte, string, bool) {
	c.mu.RLock()
	entry, ok := c.items[key]
	c.mu.RUnlock()
	if !ok || time.Now().After(entry.expiresAt) {
		return nil, "", false
	}
	return entry.data, entry.contentType, true
}

func (c *imageCache) set(key string, data []byte, contentType string) {
	if len(data) > maxEntryBytes {
		return // oversized body — don't cache
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if old, exists := c.items[key]; exists {
		c.totalBytes -= int64(len(old.data))
		delete(c.items, key)
	}
	// Evict the SOONEST-EXPIRING entry until the entry fits the budget.
	// (Reviewer note: arbitrary map iteration can evict a hot entry
	// while cold ones linger — picking the soonest expiry keeps hot
	// entries alive longer.)
	for len(c.items) > 0 &&
		(len(c.items) >= c.maxEntries || c.totalBytes+int64(len(data)) > c.maxBytes) {
		var victim string
		var soonest time.Time
		for k, v := range c.items {
			if victim == "" || v.expiresAt.Before(soonest) {
				victim, soonest = k, v.expiresAt
			}
		}
		c.totalBytes -= int64(len(c.items[victim].data))
		delete(c.items, victim)
	}
	c.items[key] = cacheEntry{
		data:        data,
		contentType: contentType,
		expiresAt:   time.Now().Add(c.ttl),
	}
	c.totalBytes += int64(len(data))
}

// reapOnce removes entries expired at the given time. Extracted from the
// loop so tests can drive expiry deterministically.
func (c *imageCache) reapOnce(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, v := range c.items {
		if now.After(v.expiresAt) {
			c.totalBytes -= int64(len(v.data))
			delete(c.items, k)
		}
	}
}

func (c *imageCache) reapLoop() {
	// A panic in map maintenance must not kill the process — recover
	// INSIDE the loop body so the reaper survives and keeps ticking
	// (a function-scope defer would unwind out of the for loop and
	// kill the reaper permanently after one panic — reviewer finding).
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("ERROR image cache reaper panicked: %v", r)
				}
			}()
			c.reapOnce(time.Now())
		}()
	}
}

// envFileCandidates returns the .env paths to try, in order: next to the
// binary (works no matter the CWD), then the dev layout (../.env when
// running from backend/), then CWD. Reviewer note: the old code was
// CWD-relative only — starting the binary from another directory made
// token writes land nowhere.
func envFileCandidates() []string {
	var out []string
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		out = append(out,
			filepath.Join(exeDir, ".env"),
			filepath.Join(exeDir, "..", ".env"),
		)
	}
	out = append(out, "../.env", ".env")
	return out
}

// loadEnvKey reads KEY=value from the environment first, then from the
// .env candidate paths.
//
// Precedence note (reviewer finding): the ENVIRONMENT wins. In-app login
// persists fresh tokens to .env, but if the process environment already
// carries PIXIV_REFRESH_TOKEN, that stale value continues to win on the
// next boot. When running with env-var credentials, don't rely on .env
// (or stop persisting to it).
func loadEnvKey(name string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	for _, path := range envFileCandidates() {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, name+"=") {
				return strings.TrimPrefix(line, name+"=")
			}
		}
	}
	return ""
}

// publicHTTPSEnabled reports whether the deployment serves the app over
// HTTPS (PIXTOK_PUBLIC_HTTPS=true — Tailscale Funnel/ngrok). When set,
// the gate cookie and the login proxy's rewritten pixiv cookies keep
// Secure (reviewer finding: Secure was stripped unconditionally, so
// session cookies could ride plaintext HTTP on the public tunnel).
// Read per-call (not at init) so tests can pin it with t.Setenv.
func publicHTTPSEnabled() bool {
	v := os.Getenv("PIXTOK_PUBLIC_HTTPS")
	if v == "" {
		v = loadEnvKey("PIXTOK_PUBLIC_HTTPS")
	}
	return v == "true" || v == "1"
}

// secureForRequest decides whether Set-Cookie responses for this request
// may carry Secure. The deployment flag alone is not enough: the same
// backend serves the public funnel (TLS terminated upstream, dialed
// plaintext at 127.0.0.1) AND direct tailnet/localhost HTTP. Stamping
// Secure on a cookie for a plaintext origin breaks the app: the browser
// stores the cookie but never sends it over HTTP, so the gate login
// "succeeds" and every follow-up request 403s (this exact bug shipped
// when PIXTOK_PUBLIC_HTTPS=true went live).
//
// Direct HTTPS is visible as r.TLS != nil; funnel requests arrive with
// X-Forwarded-Proto: https from the terminating proxy. Requests that are
// neither get a plain cookie — correct for localhost and the direct
// tailnet URL, which are HTTP transports.
func secureForRequest(r *http.Request) bool {
	if !publicHTTPSEnabled() {
		return false
	}
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// logRequests logs method + path + status for every request (path only —
// never query strings or bodies, so tokens/credentials never hit the log).
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		log.Printf("REQ %s %s -> %d (%s)", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

// appCSP is the Content-Security-Policy for pages the app itself owns.
// Scripts locked to 'self'; styles allow inline attributes (SolidJS
// positions layers with inline style attributes); images are same-origin
// through /api/img plus canvas data:/blob: sources for ugoira.
const appCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; " +
	"base-uri 'none'; form-action 'self'"

// securityHeaders sets a browser-hardening policy on every response
// (reviewer finding: the backend sent none). nosniff matters most around
// proxied image/auth content. CSP is skipped on the proxied auth paths
// (/api/auth/px/*, /ajax/*): pixiv's own login SPA is served through our
// origin there, and a restrictive CSP would break pixiv's scripts.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
		p := r.URL.Path
		if !strings.HasPrefix(p, "/api/auth/px/") && !strings.HasPrefix(p, "/ajax/") {
			h.Set("Content-Security-Policy", appCSP)
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	client, err := pixiv.NewClient()
	if err != nil {
		log.Fatalf("pixiv client: %v", err)
	}
	log.Printf("pixiv client initialized, refresh token loaded")

	imgCache := newImageCache(24*time.Hour, 2000, 512<<20)

	// Durable user prefs (blocked tags) — localStorage on the device
	// proved unreliable, so prefs live in a small SQLite DB next to the
	// backend (pixtok.db, gitignored).
	prefs, err := openPrefs("pixtok.db")
	if err != nil {
		log.Printf("WARNING: prefs db unavailable (%v) — blocked-tag persistence disabled", err)
	}

	// Loopback only — the Vite dev proxy (and only it) should reach us.
	addr := "127.0.0.1:8080"
	apiKey := loadEnvKey("PIXTOK_API_KEY")
	if apiKey == "" {
		log.Printf("WARNING: PIXTOK_API_KEY not set — API key gate DISABLED (loopback-only dev mode)")
	}
	mux := newServerBase(client, imgCache)
	if prefs != nil {
		registerPrefs(mux, prefs)
	}
	// App-owned password gate: the Funnel is public — everything behind
	// /api (feeds, images, the proxied login, prefs) locks behind a
	// password from .env. Disabled when no password is configured.
	// Plaintext dev passwords need the explicit opt-in flag (fail-closed).
	g, err := newGate(loadEnvKey("PIXTOK_GATE_PASSWORD_HASH"),
		loadEnvKey("PIXTOK_GATE_ALLOW_PLAINTEXT_DEV_ONLY") == "true")
	if err != nil {
		log.Fatalf("gate config: %v", err)
	}
	if g.enabled {
		registerGateRoutes(mux, g)
	} else {
		// The gate is the app's only defense on the public Funnel —
		// running without it deserves a loud boot warning.
		log.Printf("WARNING: PIXTOK_GATE_PASSWORD_HASH not set — password gate DISABLED")
	}

	// The .env file holds permanent pixiv credentials — warn if its
	// permissions are loose (reviewer finding). The atomic rewrite
	// writes new files 0600, but a pre-existing file may not be.
	for _, p := range envFileCandidates() {
		if fi, err := os.Stat(p); err == nil {
			if fi.Mode().Perm()&0o077 != 0 {
				log.Printf("WARNING: %s is group/world-readable (mode %04o) — chmod 600 it, it holds pixiv credentials", p, fi.Mode().Perm())
			}
			break // same precedence as loadEnvKey — first existing file wins
		}
	}

	rl := newRateLimiter(nil)

	srv := &http.Server{
		Addr:         addr,
		Handler:      originCheck(securityHeaders(logRequests(rl.middleware(apiKeyGate(apiKey, g.middleware(mux)))))),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful stop on SIGINT/SIGTERM (reviewer finding): drain
	// in-flight requests and close the prefs DB instead of dying
	// mid-request.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	log.Printf("pixtok backend listening on %s", addr)

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server: %v", err)
		}
	case <-ctx.Done():
		log.Printf("shutdown signal received — draining…")
		shCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
		if prefs != nil {
			if err := prefs.Close(); err != nil {
				log.Printf("close prefs db: %v", err)
			}
		}
		log.Printf("shutdown complete")
	}
}
