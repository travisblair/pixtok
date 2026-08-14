package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// publicHTTPS reports whether the deployment serves the app over HTTPS
// (PIXTOK_PUBLIC_HTTPS=true — Tailscale Funnel/ngrok). When set, the
// gate cookie and the login proxy's rewritten pixiv cookies keep Secure
// (reviewer finding: Secure was stripped unconditionally, so session
// cookies could ride plaintext HTTP on the public tunnel).
var publicHTTPS = func() bool {
	v := os.Getenv("PIXTOK_PUBLIC_HTTPS")
	if v == "" {
		v = loadEnvKey("PIXTOK_PUBLIC_HTTPS")
	}
	return v == "true" || v == "1"
}()

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
	g := newGate(loadEnvKey("PIXTOK_GATE_PASSWORD_HASH"))
	if g.enabled {
		registerGateRoutes(mux, g)
	} else {
		// The gate is the app's only defense on the public Funnel —
		// running without it deserves a loud boot warning.
		log.Printf("WARNING: PIXTOK_GATE_PASSWORD_HASH not set — password gate DISABLED")
	}
	srv := &http.Server{
		Addr:         addr,
		Handler:      logRequests(apiKeyGate(apiKey, g.middleware(mux))),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("pixtok backend listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}
