package pixiv

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	baseURL   = "https://app-api.pixiv.net"
	authURL   = "https://oauth.secure.pixiv.net/auth/token"
	streetURL = "https://www.pixiv.net/ajax/street/v2/main"
	homeURL   = "https://www.pixiv.net/"
	clientID  = "MOBrBDS8blbauoSck0ZfDbtuzpyT"
	clientSec = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj"
	userAgent = "PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)"
	webUA     = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
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

var imageHosts = map[string]bool{
	"i.pximg.net":                true,
	"img.pximg.net":              true,
	"s.pximg.net":                true,
	"img-zip-ugoira.i.pximg.net": true, // ugoira frame archives (zip)
}

// validAPIHost enforces the allowlist for the /api/next passthrough:
// only the Pixiv app API, https only, default port. Anything else is SSRF.
func validAPIHost(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() != "app-api.pixiv.net" {
		return false
	}
	p := u.Port()
	return p == "" || p == "443"
}

// validImageURL enforces the allowlist for the /api/img proxy:
// only Pixiv image CDN hosts, https only, default port, and NO userinfo
// or fragments (reviewer note: userinfo and fragments have no place in
// the CDN URL grammar and are classic embedding tricks).
func validImageURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || !imageHosts[u.Hostname()] {
		return false
	}
	if u.User != nil || u.Fragment != "" {
		return false
	}
	p := u.Port()
	return p == "" || p == "443"
}

type Client struct {
	refreshToken   string
	accessToken    string
	expiresAt      time.Time
	phpSessID      string
	mu             sync.Mutex
	refreshMu      sync.Mutex // single-flights refresh so concurrent requests don't stack auth calls
	csrfMu         sync.Mutex
	csrfTokenCache string
	http           *http.Client
	// followState caches IsFollowed results (TTL + single-flight) so a
	// strip feed's ~30 concurrent per-card calls collapse to one
	// upstream request per artist per window — see followstate.go.
	// nil disables caching (test clients built as literals).
	followState *followStateCache
}

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
		http:         &http.Client{Timeout: 30 * time.Second},
		// Follow state changes rarely and the frontend asks constantly —
		// 5 minutes is short enough to feel live, long enough to keep
		// the per-card fetch bursts off pixiv's rate limiter.
		followState: newFollowStateCache(5 * time.Minute),
	}

	// Also try loading PHPSESSID and the csrf token for web AJAX — env
	// first (mirrors the refresh token), .env file as fallback.
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

func (c *Client) refresh() error {
	// Single-flight: only one goroutine performs the network refresh;
	// everyone else either already sees a valid token or waits here.
	c.refreshMu.Lock()
	defer c.refreshMu.Unlock()

	c.mu.Lock()
	if !time.Now().After(c.expiresAt) {
		c.mu.Unlock() // another goroutine refreshed while we waited
		return nil
	}
	refreshToken := c.refreshToken
	c.mu.Unlock()

	data := url.Values{
		"client_id":      {clientID},
		"client_secret":  {clientSec},
		"grant_type":     {"refresh_token"},
		"refresh_token":  {refreshToken},
		"include_policy": {"true"},
	}

	req, err := http.NewRequest("POST", authURL, strings.NewReader(data.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.http.Do(req)
	if err != nil {
		// Fail fast for blocked waiters instead of serial retries.
		c.mu.Lock()
		c.expiresAt = time.Now().Add(30 * time.Second)
		c.mu.Unlock()
		return fmt.Errorf("auth request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read auth response: %w", err)
	}
	if resp.StatusCode != 200 {
		c.mu.Lock()
		c.expiresAt = time.Now().Add(30 * time.Second)
		c.mu.Unlock()
		return fmt.Errorf("auth returned %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var tr tokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return fmt.Errorf("parse auth response: %w", err)
	}

	expiresIn := tr.ExpiresIn
	if expiresIn <= 300 {
		expiresIn = 3600 // defensive: never land in the past on a bad response
	}

	// Persist a rotated refresh token BEFORE committing it to memory
	// (reviewer finding): the refresh token is the durable credential —
	// if pixiv rotates it and the disk write fails, committing to memory
	// anyway leaves memory ahead of disk, and the next restart
	// resurrects the OLD token pixiv may have just invalidated. On
	// persistence failure, fail the refresh with the circuit-breaker
	// backoff so a broken disk doesn't hammer pixiv's token endpoint;
	// memory keeps the old pair (memory never gets ahead of disk).
	if tr.RefreshToken != "" {
		if err := UpdateEnvFile(map[string]string{
			"PIXIV_REFRESH_TOKEN": tr.RefreshToken,
		}); err != nil {
			c.mu.Lock()
			c.expiresAt = time.Now().Add(30 * time.Second)
			c.mu.Unlock()
			return fmt.Errorf("persist rotated refresh token: %w", err)
		}
	}

	c.mu.Lock()
	c.accessToken = tr.AccessToken
	c.expiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second).Add(-5 * time.Minute)
	if tr.RefreshToken != "" {
		c.refreshToken = tr.RefreshToken
	}
	c.mu.Unlock()
	return nil
}

func (c *Client) ensureToken() error {
	c.mu.Lock()
	expired := time.Now().After(c.expiresAt)
	c.mu.Unlock()
	if !expired {
		return nil
	}
	return c.refresh()
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
// endpoints pass a redirect-validating client here.
func (c *Client) doWith(cl *http.Client, req *http.Request) (*http.Response, error) {
	if err := c.ensureToken(); err != nil {
		return nil, err
	}

	if req.URL.Scheme == "https" && req.URL.Hostname() == "app-api.pixiv.net" {
		c.mu.Lock()
		token := c.accessToken
		c.mu.Unlock()
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("app-os", "ios")
		req.Header.Set("app-os-version", "14.6")
	}
	req.Header.Set("User-Agent", userAgent)
	return cl.Do(req)
}

// rankingModes is the full whitelist of app-API /v1/illust/ranking modes
// (the same lists ranking.php serves). Anything else is rejected here and
// never forwarded upstream.
var rankingModes = map[string]bool{
	"day":            true,
	"week":           true,
	"month":          true,
	"day_male":       true,
	"day_female":     true,
	"week_male":      true,
	"week_female":    true,
	"week_rookie":    true,
	"week_original":  true,
	"day_ai":         true,
	"day_r18":        true,
	"day_male_r18":   true,
	"day_female_r18": true,
	"week_r18":       true,
	"week_r18g":      true,
}

// GetRankingIllust returns pixiv's ranked illust feed (app API, the same
// lists ranking.php shows — ranked in order, so position implies rank).
func (c *Client) GetRankingIllust(mode string) ([]byte, error) {
	if !rankingModes[mode] {
		return nil, fmt.Errorf("%w: invalid ranking mode", ErrInvalidParam)
	}
	u := fmt.Sprintf("%s/v1/illust/ranking?mode=%s&filter=for_ios", baseURL, mode)
	return c.doGet(u)
}

// GetNewestIllust returns the newest-upload firehose (web AJAX — the feed
// behind new_illust.php). lastID is the lastId cursor from the previous
// page (empty for the first page). r18 toggles the adult stream.
func (c *Client) GetNewestIllust(r18 bool, lastID string) ([]byte, error) {
	if lastID != "" && !ValidID(lastID) {
		return nil, fmt.Errorf("%w: invalid lastId", ErrInvalidParam)
	}
	u := fmt.Sprintf("https://www.pixiv.net/ajax/illust/new?limit=20&type=illust&r18=%t&lang=en", r18)
	if lastID != "" {
		u += "&lastId=" + lastID
	}
	return c.webGet(u)
}

// GetTopIllust returns the /illustration top page feed (web AJAX
// /ajax/top/illust — pixiv's "top" page, distinct from ranking). mode is
// all|r18.
func (c *Client) GetTopIllust(mode string) ([]byte, error) {
	if mode != "all" && mode != "r18" {
		return nil, fmt.Errorf("%w: invalid top mode", ErrInvalidParam)
	}
	u := fmt.Sprintf("https://www.pixiv.net/ajax/top/illust?mode=%s&lang=en", mode)
	return c.webGet(u)
}

// Search parameter whitelists — anything else is rejected here and never
// forwarded upstream. NOTE (verified live, Aug 2026): the type= param is
// IGNORED on /ajax/search/artworks, but HONORED on
// /ajax/search/illustrations — work type = endpoint path + type param:
//
//	all    -> /artworks (pixiv's default: illust+manga+ugoira mixed)
//	illust -> /illustrations?type=illust (illustrations only)
//	ugoira -> /illustrations?type=ugoira (ugoira only; crawled the site's
//	          own Search-option Work type control: Ugoira navigates to
//	          /tags/{tag}/illustrations?type=ugoira, totals match).
//
// popular_d is premium-gated server-side (non-premium requests silently
// fall back to date_d). Manga/Novel intentionally absent — pixtok search
// is works + illustrations + ugoira.
var (
	searchOrders     = map[string]bool{"date_d": true, "date": true}
	searchWorkModes  = map[string]bool{"all": true, "safe": true, "r18": true}
	searchWorkSModes = map[string]bool{"s_tag": true, "s_tag_full": true, "s_tc": true}
	searchWorkTypes  = map[string]bool{"all": true, "illust": true, "ugoira": true}
	searchAITypes    = map[string]bool{"0": true, "1": true}
	searchUserSModes = map[string]bool{"s_usr": true, "s_usr_full": true}
	searchDateRe     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// SearchOpts carries the verified search filters. Type selects the
// upstream endpoint + type param: "all" → /ajax/search/artworks,
// "illust" → /ajax/search/illustrations?type=illust, "ugoira" →
// /ajax/search/illustrations?type=ugoira. SCD/SCE are posting-date
// bounds (YYYY-MM-DD, empty = unbounded); AIType 0=display, 1=hide.
type SearchOpts struct {
	Order  string
	Mode   string
	SMode  string
	Type   string
	AIType string
	SCD    string
	SCE    string
}

// SearchArtworks runs a tag/free-text artworks search (web AJAX
// /ajax/search/{artworks|illustrations}/{word} — the search results
// page's feed).
func (c *Client) SearchArtworks(word string, opts SearchOpts, page int) ([]byte, error) {
	if word == "" || len(word) > 100 {
		return nil, fmt.Errorf("%w: invalid word", ErrInvalidParam)
	}
	if !searchOrders[opts.Order] || !searchWorkModes[opts.Mode] || !searchWorkSModes[opts.SMode] || !searchWorkTypes[opts.Type] {
		return nil, fmt.Errorf("%w: invalid search params", ErrInvalidParam)
	}
	if !searchAITypes[opts.AIType] {
		return nil, fmt.Errorf("%w: invalid ai_type", ErrInvalidParam)
	}
	if (opts.SCD != "" && !searchDateRe.MatchString(opts.SCD)) || (opts.SCE != "" && !searchDateRe.MatchString(opts.SCE)) {
		return nil, fmt.Errorf("%w: invalid search date", ErrInvalidParam)
	}
	if page < 1 || page > 1000 {
		return nil, fmt.Errorf("%w: invalid page", ErrInvalidParam)
	}
	ep := "artworks"
	if opts.Type == "illust" || opts.Type == "ugoira" {
		ep = "illustrations"
	}
	// Site-faithful shape (captured from the live SPA's own fetch, Aug
	// 2026): word rides the PATH only (no word= query param), and
	// csw=0&ratio= are always sent (csw=1 is "group by creator", ratio=
	// empty means "all ratios").
	u := fmt.Sprintf("https://www.pixiv.net/ajax/search/%s/%s?order=%s&mode=%s&p=%d&ai_type=%s&csw=0&s_mode=%s&ratio=",
		ep, url.PathEscape(word), opts.Order, opts.Mode, page, opts.AIType, opts.SMode)
	// type is honored ONLY on the illustrations route — never sent on
	// artworks (it is silently ignored there).
	if opts.Type == "illust" || opts.Type == "ugoira" {
		u += "&type=" + opts.Type
	}
	if opts.SCD != "" {
		u += "&scd=" + url.QueryEscape(opts.SCD)
	}
	if opts.SCE != "" {
		u += "&sce=" + url.QueryEscape(opts.SCE)
	}
	u += "&lang=en"
	return c.webGet(u)
}

// SearchUsers runs a user search (web AJAX /ajax/search/users — the
// search page's Users tab; nick + s_mode, creator-only filter off).
func (c *Client) SearchUsers(nick, sMode string, page int) ([]byte, error) {
	if nick == "" || len(nick) > 100 {
		return nil, fmt.Errorf("%w: invalid nick", ErrInvalidParam)
	}
	if !searchUserSModes[sMode] {
		return nil, fmt.Errorf("%w: invalid user search mode", ErrInvalidParam)
	}
	if page < 1 || page > 1000 {
		return nil, fmt.Errorf("%w: invalid page", ErrInvalidParam)
	}
	u := fmt.Sprintf("https://www.pixiv.net/ajax/search/users?nick=%s&s_mode=%s&p=%d&i=0&lang=en",
		url.QueryEscape(nick), sMode, page)
	return c.webGet(u)
}

// webGet performs a GET against www.pixiv.net's AJAX surface using the
// web session (PHPSESSID cookie + browser UA + Referer) — no CSRF needed
// for GETs. Errors surface as "web AJAX returned <status>".
func (c *Client) webGet(u string) ([]byte, error) {
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", webUA)
	req.Header.Set("Cookie", "PHPSESSID="+c.phpSessID)
	req.Header.Set("Referer", "https://www.pixiv.net/")

	resp, err := c.http.Do(req)
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
			return nil, fmt.Errorf("%w (web AJAX HTTP 404)", ErrNotFound)
		}
		return nil, fmt.Errorf("web AJAX returned %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
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

func (c *Client) GetRecommended() ([]byte, error) {
	u := fmt.Sprintf("%s/v1/illust/recommended?filter=for_ios", baseURL)
	return c.doGet(u)
}

// csrfToken returns (and caches) the x-csrf-token needed for street POSTs.
// The token is SESSION-BOUND: it must be fetched with the same PHPSESSID
// that will make the street calls, or pixiv 400s with a login-again error.
// The homepage HTML is Cloudflare-walled for non-browser clients, but the
// user profile page is not — it embeds the same session-bound token in its
// preloaded state.
func (c *Client) csrfToken() (string, error) {
	c.csrfMu.Lock()
	defer c.csrfMu.Unlock()
	if c.csrfTokenCache != "" {
		return c.csrfTokenCache, nil
	}
	tok, err := c.fetchCsrfToken(c.phpSessID)
	if err != nil {
		return "", err
	}
	c.csrfTokenCache = tok
	return tok, nil
}

// csrfTokenRE matches the session-bound token in the profile page's
// preloaded state (escaped JSON: token\":\"<32 hex>). Lenient so either
// quoting style works. Hoisted: fetchCsrfToken runs per session capture.
var csrfTokenRE = regexp.MustCompile(`token[^a-f0-9]{0,20}([a-f0-9]{32})`)

// fetchCsrfToken scrapes the session-bound csrf token for an ARBITRARY
// session (the login-capture path: validate + pair a freshly captured
// PHPSESSID before it becomes the active session).
func (c *Client) fetchCsrfToken(phpsessid string) (string, error) {
	// PHPSESSID is uid-prefixed (127480663_<hex>); the profile page for
	// that uid serves the token bound to this session.
	uid := strings.SplitN(phpsessid, "_", 2)[0]
	if uid == "" {
		return "", fmt.Errorf("invalid PHPSESSID format")
	}
	page := "https://www.pixiv.net/en/users/" + uid

	req, err := http.NewRequest("GET", page, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Cookie", "PHPSESSID="+phpsessid)
	req.Header.Set("User-Agent", webUA)
	req.Header.Set("Referer", "https://www.pixiv.net/")

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch profile page for csrf token: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read profile page: %w", err)
	}
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("profile page returned %d", resp.StatusCode)
	}

	// The token sits in the preloaded state as escaped JSON:
	// token\":\"<32 hex>. Match leniently so either quoting style works.
	m := csrfTokenRE.FindSubmatch(body)
	if m == nil {
		return "", fmt.Errorf("csrf token not found in profile page HTML")
	}
	return string(m[1]), nil
}

// ScrapeCsrfFor fetches + returns the csrf token bound to the given
// session (exported for the /api/auth/session capture route).
func (c *Client) ScrapeCsrfFor(phpsessid string) (string, error) {
	return c.fetchCsrfToken(phpsessid)
}

// ── In-app login capture (the /api/auth/* protocol) ─────────────────────

// ExchangePkce swaps a one-time OAuth code + PKCE verifier for the
// app-API token pair. The refresh token this returns is the durable
// credential — pixiv can rotate it on later refreshes, and refresh()
// persists the rotated value back to .env.
func (c *Client) ExchangePkce(code, codeVerifier string) (string, string, int, error) {
	data := url.Values{
		"client_id":      {clientID},
		"client_secret":  {clientSec},
		"grant_type":     {"authorization_code"},
		"code":           {code},
		"code_verifier":  {codeVerifier},
		"redirect_uri":   {"https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback"},
		"include_policy": {"true"},
	}

	req, err := http.NewRequest("POST", authURL, strings.NewReader(data.Encode()))
	if err != nil {
		return "", "", 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", "", 0, fmt.Errorf("pkce exchange request failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", "", 0, fmt.Errorf("read pkce exchange response: %w", err)
	}
	if resp.StatusCode != 200 {
		return "", "", 0, fmt.Errorf("pkce exchange returned %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var tr tokenResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return "", "", 0, fmt.Errorf("parse pkce exchange response: %w", err)
	}
	if tr.RefreshToken == "" || tr.AccessToken == "" {
		return "", "", 0, fmt.Errorf("pkce exchange returned no tokens")
	}
	return tr.RefreshToken, tr.AccessToken, tr.ExpiresIn, nil
}

// SetTokens hot-swaps the app-API token pair into the running client and
// persists the refresh token to .env (the access token is transient —
// the client refreshes on demand).
func (c *Client) SetTokens(refreshToken, accessToken string, expiresIn int) error {
	if expiresIn <= 300 {
		expiresIn = 3600
	}
	c.mu.Lock()
	c.refreshToken = refreshToken
	c.accessToken = accessToken
	c.expiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second).Add(-5 * time.Minute)
	c.mu.Unlock()
	return UpdateEnvFile(map[string]string{
		"PIXIV_REFRESH_TOKEN": refreshToken,
	})
}

// SetWebSession hot-swaps the web session (PHPSESSID + its bound csrf
// token) into the running client and persists both to .env.
func (c *Client) SetWebSession(phpsessid, csrfToken string) error {
	c.csrfMu.Lock()
	c.phpSessID = phpsessid
	c.csrfTokenCache = csrfToken
	c.csrfMu.Unlock()
	return UpdateEnvFile(map[string]string{
		"PIXIV_PHPSESSID":   phpsessid,
		"PIXTOK_CSRF_TOKEN": csrfToken,
	})
}

// AuthHealth probes both auth surfaces: the app-API token (a refresh
// round-trip means the permanent token is still valid) and the web
// session (/ajax/user/extra 200s with account data for a live session —
// unlike /ajax/top/illust, which serves anonymously even when dead).
func (c *Client) AuthHealth() (appOK bool, webOK bool) {
	appOK = c.refresh() == nil
	_, err := c.webGet("https://www.pixiv.net/ajax/user/extra?is_smartphone=0&lang=en")
	webOK = err == nil
	return appOK, webOK
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
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
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

// GetStreet fetches the modern personalized homepage feed. nextParams is
// the cursor JSON from the previous response (empty for the first page).
func (c *Client) GetStreet(nextParams string) ([]byte, error) {
	if nextParams == "" {
		nextParams = "{}"
	}

	do := func() ([]byte, error) {
		token, err := c.csrfToken()
		if err != nil {
			return nil, err
		}

		req, err := http.NewRequest("POST", streetURL, strings.NewReader(nextParams))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
		req.Header.Set("x-csrf-token", token)
		req.Header.Set("Cookie", "PHPSESSID="+c.phpSessID)
		req.Header.Set("User-Agent", webUA)
		req.Header.Set("Referer", homeURL)
		// Pixiv's CSRF check pairs the token with Origin/Accept — the site
		// sends both; omitting them yields a session-lookalike 400.
		req.Header.Set("Origin", "https://www.pixiv.net")
		req.Header.Set("Accept", "application/json")

		resp, err := c.http.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONBody))
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != 200 {
			return nil, &statusError{
				op:     "street",
				status: resp.StatusCode,
				body:   truncate(string(body), 200),
			}
		}
		return body, nil
	}

	body, err := do()
	// Retry once ONLY on 400/401 — a rotated/stale csrf token or session
	// rejection. A 403/404/429 is not a token problem: retrying doubles
	// upstream load under rate limiting and repeats a request that will
	// fail the same way. Cache invalidation is mutex-guarded and
	// race-safe. (Reviewer finding: the old window covered ALL 4xx.)
	var se *statusError
	if err != nil && errors.As(err, &se) && (se.status == 400 || se.status == 401) {
		c.csrfMu.Lock()
		c.csrfTokenCache = ""
		c.csrfMu.Unlock()
		body, err = do()
	}
	return body, err
}

func (c *Client) GetRelated(illustID string) ([]byte, error) {
	// v1/illust/related was removed by Pixiv (404 upstream) — v2 works,
	// same auth, same response shape, includes next_url pagination.
	if !ValidID(illustID) {
		return nil, fmt.Errorf("%w: invalid illust id", ErrInvalidParam)
	}
	u := fmt.Sprintf("%s/v2/illust/related?illust_id=%s&filter=for_ios", baseURL, illustID)
	return c.doGet(u)
}

// GetUserIllusts returns the artist's works (app API, paginated).
func (c *Client) GetUserIllusts(userID string) ([]byte, error) {
	if !ValidID(userID) {
		return nil, fmt.Errorf("%w: invalid user id", ErrInvalidParam)
	}
	u := fmt.Sprintf("%s/v1/user/illusts?user_id=%s&filter=for_ios", baseURL, userID)
	return c.doGet(u)
}

// GetUgoiraMeta returns the animation metadata for an ugoira work: the
// frame archive URL (zip), the frame file list with per-frame delays,
// and the frame mime type. Web AJAX, session auth.
func (c *Client) GetUgoiraMeta(illustID string) ([]byte, error) {
	if !ValidID(illustID) {
		return nil, fmt.Errorf("%w: invalid illust id", ErrInvalidParam)
	}
	u := fmt.Sprintf("https://www.pixiv.net/ajax/illust/%s/ugoira_meta?lang=en", illustID)

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Cookie", "PHPSESSID="+c.phpSessID)
	req.Header.Set("User-Agent", webUA)
	req.Header.Set("Referer", fmt.Sprintf("https://www.pixiv.net/en/artworks/%s", illustID))

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("ugoira meta returned %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

func (c *Client) BookmarkAdd(illustID string, isPrivate bool) error {
	if !ValidID(illustID) {
		return fmt.Errorf("%w: invalid illust id", ErrInvalidParam)
	}
	restrict := "public"
	if isPrivate {
		restrict = "private"
	}

	data := url.Values{
		"illust_id": {illustID},
		"restrict":  {restrict},
	}

	req, err := http.NewRequest("POST", baseURL+"/v2/illust/bookmark/add", strings.NewReader(data.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("bookmark add returned %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return nil
}

// GetBookmarkIDs collects the user's bookmarked illust ids (newest
// bookmarks first) from the app-API bookmarks feed, up to maxPages pages.
// restrict is public|private. The user id is parsed from the web
// session (PHPSESSID uid prefix) — the same account that holds the
// bearer token, so restrict=private is readable.
func (c *Client) GetBookmarkIDs(restrict string, maxPages int) ([]string, error) {
	if restrict != "public" && restrict != "private" {
		return nil, fmt.Errorf("%w: invalid restrict", ErrInvalidParam)
	}
	if maxPages < 1 || maxPages > 25 {
		return nil, fmt.Errorf("%w: invalid maxPages", ErrInvalidParam)
	}
	uid := strings.SplitN(c.phpSessID, "_", 2)[0]
	if !ValidID(uid) {
		return nil, fmt.Errorf("cannot resolve user id from web session")
	}

	next := fmt.Sprintf("%s/v1/user/bookmarks/illust?user_id=%s&restrict=%s&filter=for_ios", baseURL, uid, restrict)
	cl := c.newValidatedClient(validAPIHost)
	ids := make([]string, 0, 30*maxPages)
	for page := 0; page < maxPages && next != ""; page++ {
		req, err := http.NewRequest("GET", next, nil)
		if err != nil {
			return nil, err
		}
		resp, err := c.doWith(cl, req)
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONBody))
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("bookmarks returned %d: %s", resp.StatusCode, truncate(string(body), 200))
		}
		var parsed struct {
			Illusts []struct {
				ID json.Number `json:"id"`
			} `json:"illusts"`
			NextURL string `json:"next_url"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			return nil, err
		}
		for _, w := range parsed.Illusts {
			ids = append(ids, w.ID.String())
		}
		next = parsed.NextURL
		// The next URL comes from the upstream response, not the client —
		// still validate it against the app-API allowlist before issuing
		// a request (a compromised/malicious response must not make us
		// fetch arbitrary hosts).
		if next != "" && !validAPIHost(next) {
			return nil, fmt.Errorf("bookmarks pagination returned a non-allowlisted URL")
		}
	}
	return ids, nil
}

// GetBookmarkIllusts returns the first page of the user's bookmarked
// works (app API, standard {illusts, next_url} passthrough — the
// Bookmarks tab feed). restrict is public|private; pixtok likes are
// private.
func (c *Client) GetBookmarkIllusts(restrict string) ([]byte, error) {
	if restrict != "public" && restrict != "private" {
		return nil, fmt.Errorf("%w: invalid restrict", ErrInvalidParam)
	}
	uid := strings.SplitN(c.phpSessID, "_", 2)[0]
	if !ValidID(uid) {
		return nil, fmt.Errorf("cannot resolve user id from web session")
	}
	u := fmt.Sprintf("%s/v1/user/bookmarks/illust?user_id=%s&restrict=%s&filter=for_ios", baseURL, uid, restrict)
	return c.doGet(u)
}

// GetBookmarkPage fetches one offset page of the user's bookmarks via
// the web AJAX endpoint behind pixiv's bookmarks page (crawl-verified
// Aug 2026): tag is a bookmark-tag name (URL-encoded upstream), offset
// is blind (the response carries total), order desc|asc.
func (c *Client) GetBookmarkPage(tag string, offset, limit int, order string) ([]byte, error) {
	if offset < 0 || limit < 1 || limit > 48 {
		return nil, fmt.Errorf("%w: invalid offset/limit", ErrInvalidParam)
	}
	if order != "desc" && order != "asc" {
		return nil, fmt.Errorf("%w: invalid order", ErrInvalidParam)
	}
	uid := strings.SplitN(c.phpSessID, "_", 2)[0]
	if !ValidID(uid) {
		return nil, fmt.Errorf("cannot resolve user id from web session")
	}

	do := func() ([]byte, error) {
		token, err := c.csrfToken()
		if err != nil {
			return nil, err
		}
		u := fmt.Sprintf("https://www.pixiv.net/ajax/user/%s/illusts/bookmarks?tag=%s&offset=%d&limit=%d&rest=show&order=%s&mode=all&lang=en",
			uid, url.QueryEscape(tag), offset, limit, order)
		req, err := http.NewRequest("GET", u, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("x-csrf-token", token)
		req.Header.Set("Cookie", "PHPSESSID="+c.phpSessID)
		req.Header.Set("User-Agent", webUA)
		req.Header.Set("Referer", "https://www.pixiv.net/en/users/"+uid+"/bookmarks/artworks")
		req.Header.Set("Accept", "application/json")

		resp, err := c.http.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONBody))
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != 200 {
			return nil, &statusError{op: "bookmark page", status: resp.StatusCode, body: truncate(string(body), 200)}
		}
		return body, nil
	}

	body, err := do()
	var se *statusError
	if err != nil && errors.As(err, &se) && (se.status == 400 || se.status == 401) {
		c.csrfMu.Lock()
		c.csrfTokenCache = ""
		c.csrfMu.Unlock()
		body, err = do()
	}
	return body, err
}

// GetBookmarkTags fetches the user's bookmark-tag list (web AJAX,
// crawl-verified): body.public/private arrays of {tag, cnt}.
func (c *Client) GetBookmarkTags() ([]byte, error) {
	uid := strings.SplitN(c.phpSessID, "_", 2)[0]
	if !ValidID(uid) {
		return nil, fmt.Errorf("cannot resolve user id from web session")
	}
	do := func() ([]byte, error) {
		token, err := c.csrfToken()
		if err != nil {
			return nil, err
		}
		u := fmt.Sprintf("https://www.pixiv.net/ajax/user/%s/illusts/bookmark/tags?lang=en", uid)
		req, err := http.NewRequest("GET", u, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("x-csrf-token", token)
		req.Header.Set("Cookie", "PHPSESSID="+c.phpSessID)
		req.Header.Set("User-Agent", webUA)
		req.Header.Set("Referer", "https://www.pixiv.net/en/users/"+uid+"/bookmarks/artworks")
		req.Header.Set("Accept", "application/json")

		resp, err := c.http.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONBody))
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != 200 {
			return nil, &statusError{op: "bookmark tags", status: resp.StatusCode, body: truncate(string(body), 200)}
		}
		return body, nil
	}

	body, err := do()
	var se *statusError
	if err != nil && errors.As(err, &se) && (se.status == 400 || se.status == 401) {
		c.csrfMu.Lock()
		c.csrfTokenCache = ""
		c.csrfMu.Unlock()
		body, err = do()
	}
	return body, err
}

func (c *Client) BookmarkDelete(illustID string) error {
	if !ValidID(illustID) {
		return fmt.Errorf("%w: invalid illust id", ErrInvalidParam)
	}
	data := url.Values{"illust_id": {illustID}}

	req, err := http.NewRequest("POST", baseURL+"/v1/illust/bookmark/delete", strings.NewReader(data.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("bookmark delete returned %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return nil
}

func (c *Client) ProxyNext(nextURL string) ([]byte, error) {
	// next_url values come from the CLIENT — enforce the allowlist so
	// /api/next can't be turned into an SSRF token-exfil machine.
	if !validAPIHost(nextURL) {
		return nil, fmt.Errorf("next_url host not allowed")
	}

	req, err := http.NewRequest("GET", nextURL, nil)
	if err != nil {
		return nil, err
	}

	// Redirect-validating client + normal do() auth attachment (pagination
	// next_urls need the bearer token).
	resp, err := c.doWith(c.newValidatedClient(validAPIHost), req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONBody))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("proxy returned %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	return body, nil
}

// GetWorkRecommend fetches per-work recommendations: the works Pixiv
// recommends for the given illust ("Related works" on the artwork page).
// Web AJAX, session auth, no pagination — a finite ~18-work list.
func (c *Client) GetWorkRecommend(illustID string) ([]byte, error) {
	if !ValidID(illustID) {
		return nil, fmt.Errorf("%w: invalid illust id", ErrInvalidParam)
	}
	u := fmt.Sprintf("https://www.pixiv.net/ajax/illust/%s/recommend/init?limit=18", illustID)

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Cookie", "PHPSESSID="+c.phpSessID)
	req.Header.Set("User-Agent", webUA)
	req.Header.Set("Referer", "https://www.pixiv.net/")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxJSONBody))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("work recommend returned %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	return body, nil
}

// SetFollow follows or unfollows a user via the app API. Form-encoded
// like every other v1 mutation; restrict is "public" or "private".
// Verified live Aug 2026 (add → detail is_followed=true → delete →
// false round trip).
func (c *Client) SetFollow(userID string, restrict string, follow bool) error {
	if !ValidID(userID) {
		return fmt.Errorf("invalid user id %q", userID)
	}
	action := "delete"
	if follow {
		action = "add"
	}
	data := url.Values{
		"user_id":  {userID},
		"restrict": {restrict},
	}
	req, err := http.NewRequest("POST", baseURL+"/v1/user/follow/"+action, strings.NewReader(data.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.doWith(c.http, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("follow %s returned %d", action, resp.StatusCode)
	}
	return nil
}

// IsFollowed returns the current follow state from /v1/user/detail,
// served through the follow-state cache (TTL + single-flight). A nil
// cache (test clients) degrades to a direct fetch.
func (c *Client) IsFollowed(userID string) (bool, error) {
	if !ValidID(userID) {
		return false, fmt.Errorf("invalid user id %q", userID)
	}
	if c.followState == nil {
		return c.fetchFollowState(userID)
	}
	value, fresh, call, lead := c.followState.getOrStart(userID)
	if fresh {
		return value, nil
	}
	if lead {
		v, err := c.fetchFollowState(userID)
		c.followState.finish(userID, call, v, err)
		return v, err
	}
	// Follower: the leader's finish() closes done after storing the
	// result — the close is the happens-before edge for these reads.
	<-call.done
	return call.value, call.err
}

func (c *Client) fetchFollowState(userID string) (bool, error) {
	req, err := http.NewRequest("GET", baseURL+"/v1/user/detail?user_id="+url.QueryEscape(userID), nil)
	if err != nil {
		return false, err
	}
	resp, err := c.doWith(c.http, req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false, fmt.Errorf("user detail returned %d", resp.StatusCode)
	}
	var out struct {
		User struct {
			IsFollowed bool `json:"is_followed"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, err
	}
	return out.User.IsFollowed, nil
}

func (c *Client) ProxyImage(imgURL string) ([]byte, string, error) {
	// img URLs come from the CLIENT — enforce the CDN allowlist so
	// /api/img can't be used as an open proxy into the LAN.
	if !validImageURL(imgURL) {
		return nil, "", fmt.Errorf("image host not allowed")
	}

	req, err := http.NewRequest("GET", imgURL, nil)
	if err != nil {
		return nil, "", err
	}

	req.Header.Set("Referer", "https://www.pixiv.net/")
	req.Header.Set("User-Agent", userAgent)

	// Images/zips are the slow path on the Pi Zero (multi-MB ugoira zips
	// over a weak radio): give the image client a longer ceiling than
	// the shared 30s client. Feeds stay strict; a stalled zip burns a
	// bounded 2 minutes, then dies.
	imgClient := c.newValidatedClient(validImageURL)
	imgClient.Timeout = 120 * time.Second
	resp, err := imgClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBody))
	if err != nil {
		return nil, "", err
	}

	if resp.StatusCode != 200 {
		return nil, "", fmt.Errorf("image proxy returned %d", resp.StatusCode)
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/jpeg"
	}
	// Content-type allowlist (reviewer finding): the upstream header is
	// echoed to the browser — trust it only for types this proxy exists
	// to serve. SVG especially must stay rejected or the image proxy
	// becomes a script-capable content proxy. application/zip covers
	// ugoira frame archives.
	if mt, _, err := mime.ParseMediaType(contentType); err == nil {
		contentType = mt
	}
	switch contentType {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "application/zip":
	default:
		return nil, "", fmt.Errorf("image proxy returned disallowed content type %q", contentType)
	}

	return body, contentType, nil
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}
