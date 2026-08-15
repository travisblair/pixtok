package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// ── App-owned password gate ────────────────────────────────────────────
//
// The Funnel exposes the app on the public internet with no auth layer
// in front of it. This gate puts one: every /api route (feeds, images,
// the proxied pixiv login — everything) requires the gate cookie unless
// it's the gate's own endpoints. The password lives in .env as a bcrypt
// hash (PIXTOK_GATE_PASSWORD_HASH) — never a plaintext, never in code.
//
// Cookie scheme: pixtok_gate = HMAC-SHA256(passwordHash, "pixtok-gate")
// hex-encoded. Stateless — survives backend restarts, verifiable without
// a token store, and it changes automatically if the password changes.
// HttpOnly, SameSite=Lax, 30 days.

const gateCookie = "pixtok_gate"

type gate struct {
	mu      sync.Mutex
	hash    []byte // bcrypt hash of the configured password; nil = gate disabled
	enabled bool
	// failure tarpit: progressive delays after 5 failures (per the
	// auth-delay-tarpit pattern), capped concurrency.
	failures     int
	lastFailTime time.Time
	slots        chan struct{}
}

// newGate builds the gate from the configured password. Fail-closed
// (reviewer finding): a non-bcrypt value in PIXTOK_GATE_PASSWORD_HASH is
// only accepted as a plaintext dev password when the explicit
// PIXTOK_GATE_ALLOW_PLAINTEXT_DEV_ONLY=true flag is set — otherwise boot
// fails loudly. Security-sensitive configuration must never silently
// degrade.
func newGate(passwordHash string, allowPlaintext bool) (*gate, error) {
	g := &gate{slots: make(chan struct{}, 10)}
	if passwordHash == "" {
		return g, nil // no password configured — gate disabled
	}
	if _, err := bcrypt.Cost([]byte(passwordHash)); err != nil {
		if !allowPlaintext {
			return nil, fmt.Errorf("PIXTOK_GATE_PASSWORD_HASH is not a valid bcrypt hash — set a real hash, or set PIXTOK_GATE_ALLOW_PLAINTEXT_DEV_ONLY=true for local dev")
		}
		// Dev convenience: hash the plaintext now (in-memory only; the
		// cookie won't survive a restart, which is fine for local dev).
		h, err := bcrypt.GenerateFromPassword([]byte(passwordHash), bcrypt.DefaultCost)
		if err != nil {
			return nil, fmt.Errorf("hash gate password: %w", err)
		}
		g.hash = h
		g.enabled = true
		log.Printf("gate enabled (plaintext password hashed at boot — dev-only; set a bcrypt hash in .env for persistent sessions)")
		return g, nil
	}
	g.hash = []byte(passwordHash)
	g.enabled = true
	return g, nil
}

// validToken computes the expected cookie value for the current hash.
func (g *gate) validToken() string {
	mac := hmac.New(sha256.New, g.hash)
	mac.Write([]byte("pixtok-gate"))
	return hex.EncodeToString(mac.Sum(nil))
}

func (g *gate) checkCookie(r *http.Request) bool {
	c, err := r.Cookie(gateCookie)
	if err != nil || c.Value == "" {
		return false
	}
	expected := g.validToken()
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(expected)) == 1
}

// failureDelay returns the tarpit delay for the current failure count
// (2s → 5s → 15s → 30s → 60s) — progressive, never a lockout.
func (g *gate) failureDelay() time.Duration {
	switch {
	case g.failures < 5:
		return 0
	case g.failures < 8:
		return 2 * time.Second
	case g.failures < 11:
		return 5 * time.Second
	case g.failures < 14:
		return 15 * time.Second
	case g.failures < 17:
		return 30 * time.Second
	default:
		return 60 * time.Second
	}
}

func (g *gate) recordFailure() {
	g.mu.Lock()
	g.failures++
	g.lastFailTime = time.Now()
	g.mu.Unlock()
}

func (g *gate) recordSuccess() {
	g.mu.Lock()
	g.failures = 0
	g.mu.Unlock()
}

// unlockedPaths are reachable without the gate cookie: the gate's own
// endpoints (status + unlock) and /health. Everything else — feeds,
// images, the proxied login, prefs — is gated.
func gatePathAllowed(path string) bool {
	return path == "/api/gate/status" ||
		path == "/api/gate" ||
		path == "/health"
}

// middleware wraps the mux: gated routes 403 without a valid cookie.
func (g *gate) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !g.enabled || gatePathAllowed(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if !g.checkCookie(r) {
			http.Error(w, "gate locked", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// registerGateRoutes wires the gate's own endpoints (inside the key
// gate so the unlock endpoint isn't a free password oracle).
func registerGateRoutes(mux *http.ServeMux, g *gate) {
	mux.HandleFunc("/api/gate/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if !g.enabled {
			_, _ = w.Write([]byte(`{"locked":false}`))
			return
		}
		locked := !g.checkCookie(r)
		if locked {
			_, _ = w.Write([]byte(`{"locked":true}`))
			return
		}
		_, _ = w.Write([]byte(`{"locked":false}`))
	})

	mux.HandleFunc("/api/gate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		// JSON bodies only — forces a CORS preflight for cross-origin
		// form posts, so a third-party page can't blind-fire attempts
		// into the public funnel and pollute the failure counter.
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			http.Error(w, "invalid content type", http.StatusUnsupportedMediaType)
			return
		}
		if !g.enabled {
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		// Concurrency cap: when the tarpit is saturated, fall back to 429.
		select {
		case g.slots <- struct{}{}:
			defer func() { <-g.slots }()
		default:
			http.Error(w, "too many attempts", http.StatusTooManyRequests)
			return
		}

		g.mu.Lock()
		delay := g.failureDelay()
		sinceLast := time.Since(g.lastFailTime)
		g.mu.Unlock()
		// Slow successive failures additionally (the delay grows the
		// longer a burst goes on, even below the 5-failure floor).
		if delay > 0 && sinceLast < 2*time.Second {
			time.Sleep(min(delay, 10*time.Second))
		}

		var body struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}

		if bcrypt.CompareHashAndPassword(g.hash, []byte(body.Password)) != nil {
			g.recordFailure()
			http.Error(w, "wrong password", http.StatusUnauthorized)
			return
		}
		g.recordSuccess()

		// The unlock response carries the auth cookie — never cache it
		// (reviewer finding).
		w.Header().Set("Cache-Control", "no-store")
		http.SetCookie(w, &http.Cookie{
			Name:     gateCookie,
			Value:    g.validToken(),
			Path:     "/",
			MaxAge:   30 * 24 * 60 * 60,
			HttpOnly: true,
			Secure:   publicHTTPSEnabled(),
			SameSite: http.SameSiteLaxMode,
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
}
