package pixiv

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Core: the shared Client (construction, concurrency gates, transport,
// redirect-validated client factory, auth attachment) plus the sentinel
// errors and .env persistence. Method groups live in auth.go (token
// lifecycle), web.go (web-AJAX surface + session), appapi.go (app-API
// surface + follow state), images.go (CDN proxy).
const (
	baseURL   = "https://app-api.pixiv.net"
	userAgent = "PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)"
)

// maxJSONBody / maxImageBody cap upstream reads so a misbehaving
// upstream (or an attacker abusing the proxy) can't balloon memory.
const (
	maxJSONBody  = 10 << 20 // 10 MB
	maxImageBody = 25 << 20 // 25 MB
)

// Sentinel errors so handlers can classify failures with errors.Is
// instead of string-matching on error text (which breaks when an
// unrelated upstream error happens to contain the word).
var (
	// ErrInvalidParam marks client-side validation failures (bad mode,
	// bad page, bad id, ...) — map to HTTP 400.
	ErrInvalidParam = errors.New("invalid parameter")
	// ErrNotFound marks upstream 404s (deleted work, bad user id) —
	// map to HTTP 404.
	ErrNotFound = errors.New("not found")
)

// statusError carries an upstream HTTP status so callers can branch on
// it with errors.As — no string-matching on error text (the street
// retry used to gate on `strings.Contains(err.Error(), "street
// returned 4")` — reviewer finding; a typed error can't drift).
type statusError struct {
	op     string
	status int
	body   string
}

func (e *statusError) Error() string {
	return fmt.Sprintf("%s returned %d: %s", e.op, e.status, e.body)
}

// truncate caps text embedded in errors — upstream bodies can be large
// and must not flood logs (or leak, if an upstream ever echoes request
// material back).
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

type Client struct {
	refreshToken   string
	accessToken    string
	expiresAt      time.Time
	sessionMu      sync.Mutex // guards phpSessID + csrfTokenCache (login capture swaps them mid-flight while feeds read them)
	phpSessID      string
	mu             sync.Mutex
	refreshMu      sync.Mutex // single-flights refresh so concurrent requests don't stack auth calls
	csrfTokenCache string
	http           *http.Client
	// upstreamSlots bounds CONCURRENT non-image upstream calls (app API
	// + web AJAX). A search-page render mounts ~50 follow-state calls at
	// once; firing them all at pixiv is ~60 simultaneous TLS handshakes
	// on the Pi Zero W's single core — the handshakes starve each other's
	// CPU budget and time out in a storm (journal: TLS handshake timeout
	// bursts after every big render). Queued requests just land a beat
	// later; the browser side already carries its own aborts. nil
	// disables the gate (test clients built as literals).
	upstreamSlots chan struct{}
	// followCooldown is a circuit breaker for the follow-state firehose:
	// once pixiv's app-API answers a /v1/user/detail call with 429 (Rate
	// Limit), NO follow-state call goes upstream until the cooldown
	// passes. Retrying a hot limiter only adds pressure and draws
	// attention; the buttons stay "unknown" while it cools. Unix nanos,
	// 0 = not cooling. (Bookmarks/related/etc. stay unbroken — they are
	// single deliberate calls, not a per-render firehose.)
	followCooldown atomic.Int64
	// followState caches IsFollowed results (TTL + single-flight) so a
	// strip feed's ~30 concurrent per-card calls collapse to one
	// upstream request per artist per window — see followstate.go.
	// nil disables caching (test clients built as literals).
	followState *followStateCache
	// bookmarkIDs caches GetBookmarkIDs results (TTL + single-flight)
	// so repeat boots don't re-walk 12 upstream pages — see
	// bookmarkids.go. nil disables caching (test clients).
	bookmarkIDs *bookmarkIDsCache
}

// maxUpstreamConcurrency sizes the doWith gate: high enough that a feed
// page loads promptly, low enough that the Pi Zero W never melts on
// concurrent ECDHE handshakes (the 502-storm root cause, 2026-08-21).
const maxUpstreamConcurrency = 6

// clientTimeout caps every upstream fetch on the shared app-API client.
// The image path carries its own longer ceiling (imageClientTimeout).
const clientTimeout = 30 * time.Second

// tlsHandshakeTimeout extends Go's default 10s handshake ceiling (the
// Pi Zero's render-storm bursts starved queued handshakes).
const tlsHandshakeTimeout = 20 * time.Second

func NewClient() (*Client, error) {
	rt := os.Getenv("PIXIV_REFRESH_TOKEN")
	if rt == "" {
		// Try reading from the .env next to the backend/binary.
		data, err := os.ReadFile(envFilePath())
		if err != nil {
			return nil, fmt.Errorf("PIXIV_REFRESH_TOKEN not set and .env not found: %w", err)
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "PIXIV_REFRESH_TOKEN=") {
				rt = strings.TrimPrefix(line, "PIXIV_REFRESH_TOKEN=")
				break
			}
		}
	}
	if rt == "" {
		return nil, fmt.Errorf("PIXIV_REFRESH_TOKEN not found")
	}

	c := &Client{
		refreshToken: rt,
		http: &http.Client{
			Timeout:   clientTimeout,
			Transport: newPixivTransport(),
		},
		upstreamSlots: make(chan struct{}, maxUpstreamConcurrency),
		// Follow state changes rarely and the frontend asks constantly —
		// 30 minutes keeps the per-card fetch bursts off pixiv's rate
		// limiter while still feeling live enough for a browse-only user.
		// (Was 5 minutes; the app-API 429 storms of 2026-08-21 showed
		// even a throttled 6-at-a-time stream out-runs the limiter when
		// every render re-asks for ~50 artists.)
		followState: newFollowStateCache(followStateTTL),
		bookmarkIDs: newBookmarkIDsCache(bookmarkIDsTTL),
	}

	// Also try loading PHPSESSID and the csrf token for web AJAX — env
	// first (mirrors the refresh token), .env file as fallback. These
	// writes happen before the client is reachable by any request
	// handler, so no lock is needed yet.
	if v := os.Getenv("PIXIV_PHPSESSID"); v != "" {
		c.phpSessID = v
	}
	if v := os.Getenv("PIXTOK_CSRF_TOKEN"); v != "" {
		c.csrfTokenCache = v
	}
	if c.phpSessID == "" || c.csrfTokenCache == "" {
		data, err := os.ReadFile(envFilePath())
		if err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				line = strings.TrimSpace(line)
				if c.phpSessID == "" && strings.HasPrefix(line, "PIXIV_PHPSESSID=") {
					c.phpSessID = strings.TrimPrefix(line, "PIXIV_PHPSESSID=")
				}
				if c.csrfTokenCache == "" && strings.HasPrefix(line, "PIXTOK_CSRF_TOKEN=") {
					c.csrfTokenCache = strings.TrimPrefix(line, "PIXTOK_CSRF_TOKEN=")
				}
			}
		}
	}

	if err := c.refresh(); err != nil {
		return nil, fmt.Errorf("initial token refresh failed: %w", err)
	}
	return c, nil
}

// newPixivTransport returns the shared transport for pixiv upstream
// calls. Go's default 10s TLS handshake timeout was killing handshakes
// during the Pi Zero W's render-storm bursts (a handshake queued behind
// five others has to survive CPU contention): 20s gives that headroom
// without stretching the client's overall 30s ceiling much. The image
// proxy inherits this transport through newValidatedClient (it copies
// the client), so its 120s-ceiling streams get the same cushion.
func newPixivTransport() *http.Transport {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSHandshakeTimeout = tlsHandshakeTimeout
	return tr
}

// newValidatedClient returns a copy of the shared client whose redirect
// policy re-validates EVERY hop against the allowlist. Without this, a
// 3xx from a pixiv host to an attacker target would re-open the SSRF.
func (c *Client) newValidatedClient(check func(string) bool) *http.Client {
	cl := *c.http
	cl.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many redirects")
		}
		if !check(req.URL.String()) {
			return fmt.Errorf("redirect to disallowed host")
		}
		return nil
	}
	return &cl
}

func (c *Client) do(req *http.Request) (*http.Response, error) {
	return c.doWith(c.http, req)
}

// doWith attaches Pixiv auth (only to the Pixiv app API — never leak the
// bearer token to arbitrary hosts) and sends via the given client. Proxy
// endpoints pass a redirect-validating client here. ensureToken runs
// ONLY on the app-API path: web-AJAX calls ride the web session, not the
// app token, and must never trigger a refresh (login capture included).
func (c *Client) doWith(cl *http.Client, req *http.Request) (*http.Response, error) {
	if req.URL.Scheme == "https" && req.URL.Hostname() == "app-api.pixiv.net" {
		if err := c.ensureToken(); err != nil {
			return nil, err
		}
		c.mu.Lock()
		token := c.accessToken
		c.mu.Unlock()
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("app-os", "ios")
		req.Header.Set("app-os-version", "14.6")
	}
	// Default UA only when the caller hasn't chosen one: the web AJAX
	// surface (webGet, street, ugoira_meta, bookmarks, recommend) sends
	// webUA — a browser fingerprint pixiv's web endpoints check — and
	// clobbering it with the app UA would wall those calls off.
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", userAgent)
	}

	// Bounded upstream concurrency (see upstreamSlots on Client). The
	// slot is held only until the response HEADERS arrive — the heavy,
	// CPU-bound part is the TLS handshake, and this bounds the number of
	// them in flight. JSON bodies drain in microseconds after the gate
	// releases; the authproxy's streamed login flow is a single request.
	if c.upstreamSlots != nil {
		c.upstreamSlots <- struct{}{}
		defer func() { <-c.upstreamSlots }()
	}
	return cl.Do(req)
}

func (c *Client) doGet(u string) ([]byte, error) {
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONBody))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 200 {
		if resp.StatusCode == 404 {
			return nil, fmt.Errorf("%w (API HTTP 404)", ErrNotFound)
		}
		return nil, fmt.Errorf("API returned %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	return body, nil
}

// ValidID reports whether id is a non-empty all-digits string.
func ValidID(id string) bool {
	for _, ch := range id {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return id != ""
}

// UpdateEnvFile rewrites the given KEY=value lines in ../.env (creating
// missing keys), atomically via a unique temp file + rename. Serialized
// by envFileMu: two overlapping login flows must not interleave their
// read-modify-write (or rename a shared temp path out from under each
// other).
var envFileMu sync.Mutex

// envFilePath resolves the .env the backend reads/writes: the first
// candidate that already exists wins, otherwise the first candidate is
// used as the create target. Binary-dir-relative first so a backend
// started from any CWD still finds the same file (reviewer finding:
// the old hardcoded "../.env" silently failed from other directories).
func envFilePath() string {
	// PIXTOK_ENV_FILE pins ONE file — no candidate search (reviewer
	// finding: the search resolves to "some .env", which surprises
	// operators). When set, it is the only candidate, read AND write.
	if v := os.Getenv("PIXTOK_ENV_FILE"); v != "" {
		return v
	}
	candidates := []string{}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, ".env"),
			filepath.Join(exeDir, "..", ".env"),
		)
	}
	candidates = append(candidates, "../.env", ".env")
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return candidates[0]
}

func UpdateEnvFile(kv map[string]string) error {
	envFileMu.Lock()
	defer envFileMu.Unlock()

	// Values are written raw KEY=value — a newline would split into its
	// own line and corrupt the file (reviewer finding). Refuse rather
	// than write a malformed .env.
	for key, val := range kv {
		if strings.ContainsAny(key, "\r\n") || strings.ContainsAny(val, "\r\n") {
			return fmt.Errorf("refusing to write %q with newline into .env", key)
		}
	}

	path := envFilePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := strings.Split(string(raw), "\n")
	seen := make(map[string]bool, len(kv))
	out := make([]string, 0, len(lines)+len(kv))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		replaced := false
		for key, val := range kv {
			if strings.HasPrefix(trimmed, key+"=") {
				out = append(out, key+"="+val)
				seen[key] = true
				replaced = true
				break
			}
		}
		if !replaced {
			out = append(out, line)
		}
	}
	for key, val := range kv {
		if !seen[key] {
			out = append(out, key+"="+val)
		}
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), ".env.tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(strings.Join(out, "\n")); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}
