package pixiv

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// Web-AJAX surface: the PHPSESSID session (with its bound csrf token),
// street/newest/top/search/bookmarks-page/ugoira-meta fetches, and the
// login-capture web-session swap. All web calls send webUA + the
// session cookie; none of them trigger an app-API token refresh.
const (
	streetURL = "https://www.pixiv.net/ajax/street/v2/main"
	homeURL   = "https://www.pixiv.net/"
	webUA     = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)

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
	req.Header.Set("Cookie", "PHPSESSID="+c.webSessionID())
	req.Header.Set("Referer", "https://www.pixiv.net/")

	resp, err := c.doWith(c.http, req)
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

// webSession returns the current PHPSESSID + csrf token under one lock.
// SetWebSession swaps BOTH mid-flight (in-app login capture) while feed
// requests read them — unsynchronized reads were a data race. Callers
// that need only the session id use webSessionID().
func (c *Client) webSession() (string, string) {
	c.sessionMu.Lock()
	defer c.sessionMu.Unlock()
	return c.phpSessID, c.csrfTokenCache
}

// webSessionID returns the current PHPSESSID under the web-session lock.
func (c *Client) webSessionID() string {
	c.sessionMu.Lock()
	defer c.sessionMu.Unlock()
	return c.phpSessID
}

// setWebCache updates both halves of the web session atomically.
func (c *Client) setWebCache(phpsessid, csrfToken string) {
	c.sessionMu.Lock()
	defer c.sessionMu.Unlock()
	c.phpSessID = phpsessid
	c.csrfTokenCache = csrfToken
}

// invalidateCsrf drops the cached csrf token (a 400/401 retry path).
func (c *Client) invalidateCsrf() {
	c.sessionMu.Lock()
	c.csrfTokenCache = ""
	c.sessionMu.Unlock()
}

// csrfToken returns (and caches) the x-csrf-token needed for street POSTs.
// The token is SESSION-BOUND: it must be fetched with the same PHPSESSID
// that will make the street calls, or pixiv 400s with a login-again error.
// The homepage HTML is Cloudflare-walled for non-browser clients, but the
// user profile page is not — it embeds the same session-bound token in its
// preloaded state.
func (c *Client) csrfToken() (string, error) {
	// webSession() returns (phpSessID, csrfTokenCache) — the CACHE is the
	// token. Regression (Aug 26): the web-session-race refactor read the
	// first value and sent the PHPSESSID itself as x-csrf-token; pixiv
	// 400s that pairing with a login-again error.
	_, tok := c.webSession()
	if tok != "" {
		return tok, nil
	}
	sessID := c.webSessionID()
	tok, err := c.fetchCsrfToken(sessID)
	if err != nil {
		return "", err
	}
	c.setWebCache(sessID, tok)
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

	resp, err := c.doWith(c.http, req)
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
	match := csrfTokenRE.FindSubmatch(body)
	if match == nil {
		return "", fmt.Errorf("csrf token not found in profile page HTML")
	}
	return string(match[1]), nil
}

// ScrapeCsrfFor fetches + returns the csrf token bound to the given
// session (exported for the /api/auth/session capture route).
func (c *Client) ScrapeCsrfFor(phpsessid string) (string, error) {
	return c.fetchCsrfToken(phpsessid)
}

// SetWebSession hot-swaps the web session (PHPSESSID + its bound csrf
// token) into the running client and persists both to .env.
func (c *Client) SetWebSession(phpsessid, csrfToken string) error {
	c.setWebCache(phpsessid, csrfToken)
	return UpdateEnvFile(map[string]string{
		"PIXIV_PHPSESSID":   phpsessid,
		"PIXTOK_CSRF_TOKEN": csrfToken,
	})
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
		req.Header.Set("Cookie", "PHPSESSID="+c.webSessionID())
		req.Header.Set("User-Agent", webUA)
		req.Header.Set("Referer", homeURL)
		// Pixiv's CSRF check pairs the token with Origin/Accept — the site
		// sends both; omitting them yields a session-lookalike 400.
		req.Header.Set("Origin", "https://www.pixiv.net")
		req.Header.Set("Accept", "application/json")

		resp, err := c.doWith(c.http, req)
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
		c.invalidateCsrf()
		body, err = do()
	}
	return body, err
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
	req.Header.Set("Cookie", "PHPSESSID="+c.webSessionID())
	req.Header.Set("User-Agent", webUA)
	req.Header.Set("Referer", fmt.Sprintf("https://www.pixiv.net/en/artworks/%s", illustID))

	resp, err := c.doWith(c.http, req)
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
	uid := strings.SplitN(c.webSessionID(), "_", 2)[0]
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
		req.Header.Set("Cookie", "PHPSESSID="+c.webSessionID())
		req.Header.Set("User-Agent", webUA)
		req.Header.Set("Referer", "https://www.pixiv.net/en/users/"+uid+"/bookmarks/artworks")
		req.Header.Set("Accept", "application/json")

		resp, err := c.doWith(c.http, req)
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
		c.invalidateCsrf()
		body, err = do()
	}
	return body, err
}

// GetBookmarkTags fetches the user's bookmark-tag list (web AJAX,
// crawl-verified): body.public/private arrays of {tag, cnt}.
func (c *Client) GetBookmarkTags() ([]byte, error) {
	uid := strings.SplitN(c.webSessionID(), "_", 2)[0]
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
		req.Header.Set("Cookie", "PHPSESSID="+c.webSessionID())
		req.Header.Set("User-Agent", webUA)
		req.Header.Set("Referer", "https://www.pixiv.net/en/users/"+uid+"/bookmarks/artworks")
		req.Header.Set("Accept", "application/json")

		resp, err := c.doWith(c.http, req)
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
		c.invalidateCsrf()
		body, err = do()
	}
	return body, err
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
	req.Header.Set("Cookie", "PHPSESSID="+c.webSessionID())
	req.Header.Set("User-Agent", webUA)
	req.Header.Set("Referer", "https://www.pixiv.net/")

	resp, err := c.doWith(c.http, req)
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
