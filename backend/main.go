package main

import (
	"log"
	"net/http"
	"os"
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
	// Evict (arbitrary order) until the entry fits the budget.
	for len(c.items) > 0 &&
		(len(c.items) >= c.maxEntries || c.totalBytes+int64(len(data)) > c.maxBytes) {
		for k, v := range c.items {
			c.totalBytes -= int64(len(v.data))
			delete(c.items, k)
			break
		}
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
	// A panic in map maintenance must not kill the process — recover and
	// keep the reaper alive (matches the cleanup-goroutine pattern).
	defer func() {
		if r := recover(); r != nil {
			log.Printf("ERROR image cache reaper panicked: %v", r)
		}
	}()
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		c.reapOnce(time.Now())
	}
}

// loadEnvKey reads KEY=value from ../.env (backend started from backend/).
func loadEnvKey(name string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	data, err := os.ReadFile("../.env")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, name+"=") {
			return strings.TrimPrefix(line, name+"=")
		}
	}
	return ""
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
