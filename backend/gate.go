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
	// freshHash is the bcrypt hash generated THIS BOOT from a plaintext
	// dev password (nil when a real hash was configured). main()
	// persists it into .env so the next boot loads a stable hash and
	// unlocked sessions survive restarts instead of re-locking.
	freshHash []byte
	// failure tarpit: progressive delays after 5 failures (per the
	// auth-delay-tarpit pattern), capped concurrency.
	failures     int
	lastFailTime time.Time
	slots        chan struct{}
	// hashSlots bounds CONCURRENT bcrypt compares: the sleep slot above
	// is only taken after the compare, so it can never bound the compare
	// itself. Without this budget a wrong-password flood runs unbounded
	// concurrent bcrypt.
	hashSlots chan struct{}
}

// newGate builds the gate from the configured password. Fail-closed
// (reviewer finding): a non-bcrypt value in PIXTOK_GATE_PASSWORD_HASH is
// only accepted as a plaintext dev password when the explicit
// PIXTOK_GATE_ALLOW_PLAINTEXT_DEV_ONLY=true flag is set — otherwise boot
// fails loudly. Security-sensitive configuration must never silently
// degrade.
func newGate(passwordHash string, allowPlaintext bool) (*gate, error) {
	g := &gate{slots: make(chan struct{}, 10), hashSlots: make(chan struct{}, 8)}
	if passwordHash == "" {
		return g, nil // no password configured — gate disabled
	}
	if _, err := bcrypt.Cost([]byte(passwordHash)); err != nil {
		if !allowPlaintext {
			return nil, fmt.Errorf("PIXTOK_GATE_PASSWORD_HASH is not a valid bcrypt hash — set a real hash, or set PIXTOK_GATE_ALLOW_PLAINTEXT_DEV_ONLY=true for local dev")
		}
		// Dev convenience: hash the plaintext now and hand main() the
		// hash to persist into .env, so the password is upgraded to a
		// stable bcrypt hash and unlocked sessions survive restarts.
		h, err := bcrypt.GenerateFromPassword([]byte(passwordHash), bcrypt.DefaultCost)
		if err != nil {
			return nil, fmt.Errorf("hash gate password: %w", err)
		}
		g.hash = h
		g.freshHash = h
		g.enabled = true
		log.Printf("gate enabled (plaintext password hashed at boot — persisting the bcrypt hash to .env so sessions survive restarts)")
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

// tarpitMaxSleep caps a single tarpit sleep: the sleep runs BEFORE the
// 401 is written, and the server kills a handler cycle that outlives
// the connection's write deadline — an uncapped 30s/60s sleep could
// only ever write its 401 to a dead connection (exactly what the
// reorder that dropped the old 10s cap reintroduced). 25s keeps the
// 401 under the WriteTimeout with margin for the write itself; the
// longer tiers collapse onto the cap.
const tarpitMaxSleep = 25 * time.Second

// tarpitSleep returns the effective sleep before a failed attempt's
// 401: zero when the spacing guard skips the tarpit (the previous
// failure was ≥2s ago — a slow human retry is not a burst) or when no
// delay tier applies, otherwise the tier delay capped at
// tarpitMaxSleep so the 401 stays under the WriteTimeout.
func tarpitSleep(delay time.Duration, sinceLast time.Duration) time.Duration {
	if delay <= 0 || sinceLast >= 2*time.Second {
		return 0
	}
	return min(delay, tarpitMaxSleep)
}

// gateFailureDecay: failures older than this stop counting against the
// owner (reviewer finding): the counter never decayed, so a single old
// attack left the sole user facing 60s tarpits indefinitely.
const gateFailureDecay = 10 * time.Minute

// recordFailure registers a failed attempt and returns the time since
// the previous failure (zero when there was none). The gap is captured
// under the same lock as the increment: the reorder measured
// time.Since(lastFailTime) AFTER calling this, and since this stamps
// lastFailTime = now, the spacing guard always read ~0 — even
// deliberately spaced retries slept the full tier.
func (g *gate) recordFailure() time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	var sinceLast time.Duration
	if !g.lastFailTime.IsZero() {
		sinceLast = time.Since(g.lastFailTime)
	}
	if g.failures > 0 && sinceLast > gateFailureDecay {
		g.failures = 0 // stale attack — start a fresh streak
	}
	g.failures++
	g.lastFailTime = time.Now()
	return sinceLast
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
	if path == "/api/gate/status" ||
		path == "/api/gate" ||
		path == "/health" {
		return true
	}
	// Login-flow continuation legs (root-relative POSTs from pixiv's
	// proxied SPA): they arrive mid-login, when the gate is by definition
	// still locked. Flow-cookie gated inside serveProxy.
	return path == "/account-selected" || path == "/account-selected/" ||
		path == "/web/v1/login" || path == "/web/v1/login/" ||
		path == "/web/v1/users/auth/pixiv/start" || path == "/web/v1/users/auth/pixiv/start/"
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
		// Concurrency cap moved BELOW the password check: the slot now
		// bounds concurrent wrong-password SLEEPERS only. The owner's
		// correct unlock never contends with them (the old order 429'd
		// the owner during a flood).

		var body struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}

		// Bound the bcrypt compare itself — the sleep slot below is
		// taken only AFTER the compare, so it never bounded this: a
		// wrong-password flood would otherwise run unbounded concurrent
		// bcrypt. Non-blocking: at most 8 compares in flight; when all
		// are busy the attempt is refused up front (429). The owner can
		// hit that refusal mid-flood too, but only briefly — hash slots
		// free in bcrypt time (tens of ms), and the correct password
		// never queues behind a SLEEPER.
		select {
		case g.hashSlots <- struct{}{}:
		default:
			http.Error(w, "too many attempts", http.StatusTooManyRequests)
			return
		}
		correct := bcrypt.CompareHashAndPassword(g.hash, []byte(body.Password)) == nil
		<-g.hashSlots // release before the sleep phase — a sleeper must not hold a hash slot

		if correct {
			g.recordSuccess()
			// The unlock response carries the auth cookie — never cache
			// it (reviewer finding).
			w.Header().Set("Cache-Control", "no-store")
			http.SetCookie(w, &http.Cookie{
				Name:     gateCookie,
				Value:    g.validToken(),
				Path:     "/",
				MaxAge:   30 * 24 * 60 * 60,
				HttpOnly: true,
				Secure:   secureForRequest(r),
				SameSite: http.SameSiteLaxMode,
			})
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}

		// Spacing-guard input: the gap to the PREVIOUS failure, from
		// recordFailure() before it stamps lastFailTime = now. Measuring
		// time.Since(lastFailTime) after the stamp always read ~0, so
		// even spaced-out attempts slept the full tier.
		sinceLast := g.recordFailure()

		// The slot bounds CONCURRENT SLEEPERS only (the check is done).
		select {
		case g.slots <- struct{}{}:
			defer func() { <-g.slots }()
		default:
			http.Error(w, "too many attempts", http.StatusTooManyRequests)
			return
		}

		g.mu.Lock()
		delay := g.failureDelay()
		g.mu.Unlock()

		// Slow successive failures additionally, capped so the 401 stays
		// deliverable (see tarpitMaxSleep). Spaced-out retries skip the
		// sleep entirely.
		if sleep := tarpitSleep(delay, sinceLast); sleep > 0 {
			time.Sleep(sleep)
		}

		http.Error(w, "wrong password", http.StatusUnauthorized)
	})
}
