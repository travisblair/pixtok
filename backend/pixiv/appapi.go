package pixiv

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// App-API surface (app-api.pixiv.net, bearer auth): ranking, feeds,
// related/artist works, bookmarks, follow state, pagination proxy.
// The follow-state 429 circuit breaker and its cache live here.
// followCooldownDuration is how long the follow-state circuit breaker
// stays open after an upstream 429. Long enough for pixiv's per-window
// limiter to cool, short enough that a later render repopulates the
// buttons once it has.
const followCooldownDuration = 5 * time.Minute

// ErrFollowCooldown marks a follow-state answer of "unknown" during the
// 429 circuit-breaker window. It is NOT an upstream failure: the
// handler answers 200 with a null followed field so the button hides
// without an error toast or journal noise.
var ErrFollowCooldown = errors.New("follow state cooling down after upstream 429")

// validAPIHost enforces the allowlist for the /api/next passthrough:
// only the Pixiv app API, https only, default port. Anything else is SSRF.
func validAPIHost(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() != "app-api.pixiv.net" {
		return false
	}
	port := u.Port()
	return port == "" || port == "443"
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

func (c *Client) GetRecommended() ([]byte, error) {
	u := fmt.Sprintf("%s/v1/illust/recommended?filter=for_ios", baseURL)
	return c.doGet(u)
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
	uid := strings.SplitN(c.webSessionID(), "_", 2)[0]
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
		for _, work := range parsed.Illusts {
			ids = append(ids, work.ID.String())
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
	uid := strings.SplitN(c.webSessionID(), "_", 2)[0]
	if !ValidID(uid) {
		return nil, fmt.Errorf("cannot resolve user id from web session")
	}
	u := fmt.Sprintf("%s/v1/user/bookmarks/illust?user_id=%s&restrict=%s&filter=for_ios", baseURL, uid, restrict)
	return c.doGet(u)
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
	// The user's own toggle is authoritative: drop the cached state so
	// every other FollowButton for this artist re-fetches immediately
	// instead of showing the pre-toggle value for the rest of the TTL.
	if c.followState != nil {
		c.followState.invalidate(userID)
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
	// Circuit breaker: see followCooldown on Client. While cooling, the
	// answer is "unknown" without touching pixiv — surfaced as
	// ErrFollowCooldown so the handler can answer 200-null instead of
	// manufacturing a 502.
	if until := c.followCooldown.Load(); until != 0 && time.Now().UnixNano() < until {
		return false, ErrFollowCooldown
	}
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
		if resp.StatusCode == 429 {
			// Trip the breaker — stop asking until the limiter cools.
			c.followCooldown.Store(time.Now().Add(followCooldownDuration).UnixNano())
		}
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
