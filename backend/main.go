package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

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
	// stop ends the reaper goroutine at shutdown; reapDone closes when it
	// has actually returned, so Stop() can be synchronous and a test can
	// assert the goroutine is gone.
	stop     chan struct{}
	reapDone chan struct{}
	stopOnce sync.Once
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
		stop:       make(chan struct{}),
		reapDone:   make(chan struct{}),
	}
	go c.reapLoop()
	return c
}

// Stop ends the reaper goroutine and waits for it to return. Idempotent
// (review finding: the reaper was never stopped, so it outlived the
// server during shutdown and raced the process teardown).
func (c *imageCache) Stop() {
	c.stopOnce.Do(func() { close(c.stop) })
	<-c.reapDone
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

// imageCacheReapInterval is how often the cache reaper sweeps expired
// entries (the loop must stay panic-proof — see below).
const imageCacheReapInterval = 5 * time.Minute

func (c *imageCache) reapLoop() {
	// A panic in map maintenance must not kill the process — recover
	// INSIDE the loop body so the reaper survives and keeps ticking
	// (a function-scope defer would unwind out of the for loop and
	// kill the reaper permanently after one panic — reviewer finding).
	// Closed on Stop() so shutdown does not leave the goroutine behind.
	defer close(c.reapDone)
	ticker := time.NewTicker(imageCacheReapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
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
}

// loadEnvKey reads KEY=value through the ONE resolver in pixiv: the
// process environment wins, then the first candidate .env file that
// contains the key. Read, write and the boot permission check all share
// pixiv.EnvCandidates(), so they can never disagree about which file
// holds a credential.
//
// Precedence note (reviewer finding): the ENVIRONMENT wins. In-app login
// persists fresh tokens to .env, but a refresh token already present in
// the process environment keeps winning on the next boot. When running
// with env-var credentials, don't rely on .env (or stop persisting to it).
func loadEnvKey(name string) string {
	return pixiv.ReadEnvKey(name)
}

// checkEnvFilePermissions refuses to boot when any .env candidate that
// could supply a credential is group/world-writable, and warns when one
// is group/world-readable. EVERY existing candidate is checked, not just
// the first: the resolver reads a key from the first file CONTAINING it,
// so a later file can be the file that actually supplies the credential
// (review finding: the old loop `break`ed at the first existing file and
// could therefore inspect a file with no credentials in it).
func checkEnvFilePermissions(candidates []string) error {
	for _, p := range candidates {
		fi, err := os.Stat(p)
		if err != nil {
			continue
		}
		if fi.Mode().Perm()&0o022 != 0 {
			return fmt.Errorf("%s is group/world-writable (mode %04o) — refusing to boot: an attacker who can write this file owns the pixiv credential", p, fi.Mode().Perm())
		}
		if fi.Mode().Perm()&0o077 != 0 {
			log.Printf("WARNING: %s is group/world-readable (mode %04o) — chmod 600 it, it holds pixiv credentials", p, fi.Mode().Perm())
		}
	}
	return nil
}

// publicHTTPSEnabled reports whether the deployment serves the app over
// HTTPS (PIXTOK_PUBLIC_HTTPS=true — Tailscale Funnel/ngrok). When set,
// the gate cookie and the login proxy's rewritten pixiv cookies keep
// Secure (reviewer finding: Secure was stripped unconditionally, so
// session cookies could ride plaintext HTTP on the public tunnel).
//
// Resolved ONCE and cached: securityHeaders asks this on every response,
// and the uncached version ran os.Executable + os.ReadFile(.env) per
// asset/image request on the Pi — with a transient read failure silently
// downgrading the Secure flag. The posture is boot config; a change takes
// a restart (which is how every other PIXTOK_* toggle behaves).
// resetPublicHTTPSCache is the test hook.
func publicHTTPSEnabled() bool {
	publicHTTPSOnce.Do(func() {
		v := os.Getenv("PIXTOK_PUBLIC_HTTPS")
		if v == "" {
			v = pixiv.ReadEnvKey("PIXTOK_PUBLIC_HTTPS")
		}
		publicHTTPSCached = v == "true" || v == "1"
	})
	return publicHTTPSCached
}

var (
	publicHTTPSOnce   sync.Once
	publicHTTPSCached bool
)

// resetPublicHTTPSCache re-resolves the posture on the next call. Tests
// only: production resolves it exactly once, at boot.
func resetPublicHTTPSCache() {
	publicHTTPSOnce = sync.Once{}
	publicHTTPSCached = false
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

// Unwrap lets http.ResponseController reach the underlying writer so
// per-response deadlines (the 120s image write deadline) actually apply
// (found live: without it SetWriteDeadline fails with "feature not
// supported" and oversized zips die at the global WriteTimeout).
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

// maxLogFieldBytes caps every attacker-controlled field written into a
// journal line. Method/path/Origin/Host arrive from the wire, and
// MaxHeaderBytes only bounds the whole header block — without this cap a
// single request can write a multi-MB line and fill the Pi's SD card
// (measured: a 100 KB path produced a 100,046-byte line).
const maxLogFieldBytes = 200

// maxRequestPathBytes refuses absurd request paths with 414 before any
// handler or the REQ logger sees them. No route this app serves needs a
// longer path; pagination data rides the query string.
const maxRequestPathBytes = 2048

// logField makes an attacker-controlled value safe for a journal line:
// control bytes are replaced (a decoded %0A in a path would otherwise
// forge whole log records) and the length is capped on a rune boundary.
func logField(s string) string {
	s = sanitizeLogText(s)
	if len(s) <= maxLogFieldBytes {
		return s
	}
	cut := maxLogFieldBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

// requestPathLimit turns an over-long request path into a 414 before any
// downstream work. It sits INSIDE the rate limiter so a flood of
// over-long URIs still spends tokens instead of getting free 414s.
func requestPathLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.Path) > maxRequestPathBytes {
			log.Printf("WARN request path too long (%d bytes) — 414", len(r.URL.Path))
			http.Error(w, "request URI too long", http.StatusRequestURITooLong)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// logRequests logs method + path + status for every request (path only —
// never query strings or bodies, so tokens/credentials never hit the log).
// Both fields are attacker-controlled, so both are sanitized and capped;
// %q keeps each field on one clearly-delimited journal line.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		log.Printf("REQ %s %q -> %d (%s)", logField(r.Method), logField(r.URL.Path), rec.status, time.Since(start).Round(time.Millisecond))
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
		// HSTS only when the request is actually secure (TLS or a
		// trusted-proxy https) — never over plain HTTP, where it would
		// poison the origin for later HTTPS visits.
		if secureForRequest(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// cacheConfigFromEnv reads the image-cache sizing knobs with Pi-safe
// defaults (the Pi Zero W's whole RAM is 512MB — Mac-sized defaults
// would starve it if a deploy forgot its .env overrides). Bigger
// machines opt UP via env. Malformed values log and fall back: cache
// sizing is performance, not security — never block boot on it.
func cacheConfigFromEnv() (time.Duration, int, int64) {
	ttl := 6 * time.Hour
	if v := loadEnvKey("PIXTOK_CACHE_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			ttl = d
		} else {
			log.Printf("WARNING: bad PIXTOK_CACHE_TTL %q — using default", v)
		}
	}
	entries := 300
	if v := loadEnvKey("PIXTOK_CACHE_ENTRIES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			entries = n
		} else {
			log.Printf("WARNING: bad PIXTOK_CACHE_ENTRIES %q — using default", v)
		}
	}
	maxBytes := int64(64 << 20)
	if v := loadEnvKey("PIXTOK_CACHE_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			maxBytes = n
		} else {
			log.Printf("WARNING: bad PIXTOK_CACHE_BYTES %q — using default", v)
		}
	}
	return ttl, entries, maxBytes
}

// Server timeouts. The write timeout covers the WHOLE handler cycle; slow
// relay routes override it per response (see handlers.go). The header cap
// is deliberately small: the default 1 MB lets a single request carry a
// ~1 MB Origin/path into the log path.
const (
	serverReadTimeout    = 10 * time.Second
	serverWriteTimeout   = 15 * time.Second
	serverIdleTimeout    = 60 * time.Second
	serverMaxHeaderBytes = 32 << 10
)

// middlewareChain is THE middleware order for the server, extracted from
// main() so a test can pin it. Notes on the two load-bearing positions:
//   - logRequests wraps the rate limiter (every request, including 429s,
//     gets a REQ line) but its fields are sanitized and capped.
//   - originCheck sits INSIDE the rate limiter: a cross-origin mutation
//     must spend a token before it is rejected, or rejects are a free
//     unbounded journal-write amplifier.
func middlewareChain(h http.Handler, rl *rateLimiter) http.Handler {
	return securityHeaders(logRequests(rl.middleware(requestPathLimit(originCheck(h)))))
}

// newHTTPServer builds the listener config. Extracted so tests can pin
// the timeouts and the header cap.
func newHTTPServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:           addr,
		Handler:        handler,
		ReadTimeout:    serverReadTimeout,
		WriteTimeout:   serverWriteTimeout,
		IdleTimeout:    serverIdleTimeout,
		MaxHeaderBytes: serverMaxHeaderBytes,
	}
}

// validateListenAddr enforces the loopback-only posture the docs and
// SECURITY.md promise: the reverse proxy (Vite/tailscale serve/Funnel) is
// the only exposed listener and it dials 127.0.0.1. A non-loopback bind
// puts a plaintext-HTTP backend on the LAN, so it refuses to boot unless
// PIXTOK_ALLOW_PUBLIC_LISTEN=true records that the operator means it (the
// caller then warns loudly). Returns whether the bind is loopback.
func validateListenAddr(addr string, allowPublic bool) (bool, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false, fmt.Errorf("PIXTOK_LISTEN %q is not host:port: %w", addr, err)
	}
	if isLoopbackHost(host) {
		return true, nil
	}
	if allowPublic {
		return false, nil
	}
	return false, fmt.Errorf("PIXTOK_LISTEN %q binds a non-loopback interface — refusing to boot: keep the backend on 127.0.0.1 and let the reverse proxy expose it (set PIXTOK_ALLOW_PUBLIC_LISTEN=true to override deliberately)", addr)
}

// serverShutdownDrain bounds the graceful drain. It must cover the
// longest *bounded* handler budget — the gate tarpit (25s cap) and the
// auth-proxy upstream timeout (30s) — because a 5s drain cut both off
// mid-flight. The 120s image relay can still outlive it: systemd's
// TimeoutStopSec is 90s, so a longer drain only gets the process
// SIGKILLed before cleanup runs.
const serverShutdownDrain = 30 * time.Second

// shutdownCleanup is the ONE cleanup path. The cache reaper is always
// stopped; the prefs DB is closed ONLY after a clean drain — closing it
// while handlers are still running (the timed-out-Shutdown case) turns
// their preference writes into "database is closed" errors. Boot
// failures used to skip prefs.Close entirely; routing every exit through
// here fixes both.
func shutdownCleanup(cache *imageCache, prefs *prefsStore, drained bool) {
	if cache != nil {
		cache.Stop()
	}
	if !drained || prefs == nil {
		return
	}
	if err := prefs.Close(); err != nil {
		log.Printf("close prefs db: %v", err)
	}
}

func main() {
	// Every exit path funnels through run()'s defers (cache reaper stop,
	// conditional prefs close); a log.Fatalf here would skip them.
	if err := run(); err != nil {
		log.Fatalf("%v", err)
	}
}

func run() error {
	// The .env file holds permanent pixiv credentials — check the
	// permissions of EVERY candidate that could supply one BEFORE
	// anything writes to any of them (the old order let a rotated token
	// or a fresh gate hash land in a world-writable file before the fatal
	// check refused boot). Group/world-WRITABLE is fatal (fail-closed):
	// anyone who can write the file owns the pixiv credential. Merely
	// readable keeps the warning.
	if err := checkEnvFilePermissions(pixiv.EnvCandidates()); err != nil {
		return fmt.Errorf("env file: %w", err)
	}

	client, err := pixiv.NewClient()
	if err != nil {
		return fmt.Errorf("pixiv client: %w", err)
	}
	log.Printf("pixiv client initialized, refresh token loaded")

	imgCache := newImageCache(cacheConfigFromEnv())
	// ONE cleanup path for every exit (boot failure, listen error,
	// signal): stop the reaper always, close the prefs DB only when the
	// server drained cleanly. `drained` is read when the defer runs.
	var prefs *prefsStore
	drained := false
	defer func() { shutdownCleanup(imgCache, prefs, drained) }()

	// Durable user prefs (blocked tags) — localStorage on the device
	// proved unreliable, so prefs live in a small SQLite DB next to the
	// backend (pixtok.db, gitignored).
	prefs, err = openPrefs("pixtok.db")
	if err != nil {
		log.Printf("WARNING: prefs db unavailable (%v) — blocked-tag persistence disabled", err)
		prefs = nil
	}

	// Loopback only — the Vite dev proxy (and only it) should reach us.
	// A non-loopback PIXTOK_LISTEN refuses to boot unless explicitly
	// overridden (see validateListenAddr); the override warns loudly
	// because the backend speaks plaintext HTTP.
	addr := loadEnvKey("PIXTOK_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	allowPublicListen := loadEnvKey("PIXTOK_ALLOW_PUBLIC_LISTEN") == "true"
	listenLoopback, err := validateListenAddr(addr, allowPublicListen)
	if err != nil {
		return fmt.Errorf("listen config: %w", err)
	}
	if !listenLoopback {
		log.Printf("WARNING: PIXTOK_LISTEN=%s binds a NON-LOOPBACK interface — this backend serves plaintext HTTP and is now reachable beyond this host. The reverse proxy (serve/Funnel) is the intended exposure point; PIXTOK_ALLOW_PUBLIC_LISTEN=true acknowledged the override.", addr)
	}
	apiKey := loadEnvKey("PIXTOK_API_KEY")
	if apiKey == "" {
		// Fail-closed truth, not "disabled": apiKeyGate 401s every /api
		// request except /health when no key is configured (frontend
		// serving ignores the key entirely and uses the gate cookie).
		log.Printf("WARNING: PIXTOK_API_KEY not set — the API-key gate FAILS CLOSED: every /api request except /health will 401 until it is set (frontend-serve mode ignores the key and authenticates with the gate cookie)")
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
		return fmt.Errorf("gate config: %w", err)
	}
	if !g.enabled {
		// The gate is the app's only defense on the public Funnel —
		// running without it deserves a loud boot warning.
		log.Printf("WARNING: PIXTOK_GATE_PASSWORD_HASH not set — password gate DISABLED")
	}
	// Registered even when the gate is disabled: the frontend's boot
	// pre-flight asks /api/gate/status, and a 404 there pins the app on
	// the GateScreen forever (observed live). The handlers answer
	// {"locked":false} when the gate is off.
	registerGateRoutes(mux, g)
	// A plaintext dev password was hashed at boot with a fresh salt —
	// without persistence every restart mints a different hash and
	// re-locks every device. Persist the generated bcrypt hash into
	// .env once so sessions survive; also strictly safer than leaving
	// plaintext in the file.
	if len(g.freshHash) > 0 {
		if err := pixiv.UpdateEnvFile(map[string]string{
			"PIXTOK_GATE_PASSWORD_HASH": string(g.freshHash),
		}); err != nil {
			log.Printf("WARNING: could not persist gate hash to .env (%v) — the gate will re-lock on restart", err)
		}
	}

	// The .env file holds permanent pixiv credentials — warn if its
	// permissions are loose. Moved to the TOP of main() (before any
	// credential write can land in the file).

	// Prod serving: the Go binary serves the embedded frontend and the
	// gate cookie is the sole /api credential — a browser can never hold
	// the API key the dev proxy injects, so the key gate is skipped.
	// FAIL-CLOSED: frontend serving without an enabled gate would mean
	// an unauthenticated public app — refuse to boot.
	// Resolve the public-HTTPS posture once, at boot: it decides the
	// Secure attribute on every cookie and HSTS on every response, and
	// re-reading .env per response was a per-request syscall on the Pi.
	log.Printf("public HTTPS posture: %v (PIXTOK_PUBLIC_HTTPS)", publicHTTPSEnabled())

	serveFrontend := loadEnvKey("PIXTOK_SERVE_FRONTEND") == "true"
	if err := validateProdServe(serveFrontend, g.enabled); err != nil {
		return fmt.Errorf("prod serve config: %w", err)
	}
	if serveFrontend && apiKey != "" {
		log.Printf("PIXTOK_API_KEY is set but ignored in frontend-serve mode — the gate cookie is the auth")
	}

	var handler http.Handler
	if serveFrontend {
		root := http.NewServeMux()
		root.Handle("/api/", g.middleware(mux))
		root.Handle("/ajax/", g.middleware(mux))
		root.Handle("/health", g.middleware(mux))
		// Login-flow continuation legs: pixiv's proxied SPA POSTs to
		// ROOT-RELATIVE paths mid-login. They must reach the authproxy
		// handlers on `mux` instead of the SPA fallback below (the old
		// wiring made them unreachable in frontend-serve mode).
		root.Handle("/account-selected", g.middleware(mux))
		root.Handle("/account-selected/", g.middleware(mux))
		root.Handle("/web/v1/login", g.middleware(mux))
		root.Handle("/web/v1/login/", g.middleware(mux))
		root.Handle("/web/v1/users/auth/pixiv/start", g.middleware(mux))
		root.Handle("/web/v1/users/auth/pixiv/start/", g.middleware(mux))
		root.Handle("/", staticHandler())
		handler = root
	} else {
		handler = apiKeyGate(apiKey, g.middleware(mux))
	}

	rl := newRateLimiter(nil)

	srv := newHTTPServer(addr, middlewareChain(handler, rl))

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
			return fmt.Errorf("server: %w", err)
		}
		// ListenAndServe returned on its own: no handler can be in flight.
		drained = true
	case <-ctx.Done():
		log.Printf("shutdown signal received — draining…")
		shCtx, cancel := context.WithTimeout(context.Background(), serverShutdownDrain)
		defer cancel()
		if err := srv.Shutdown(shCtx); err != nil {
			// A timed-out drain means handlers are STILL RUNNING.
			// Closing the prefs DB now would turn their writes into
			// "database is closed" errors, so leave it open and let
			// process exit release it.
			log.Printf("shutdown: %v — handlers still running; leaving the prefs db open", err)
		} else {
			drained = true
		}
		log.Printf("shutdown complete")
	}
	return nil
}
