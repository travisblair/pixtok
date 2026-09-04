package pixiv

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Token lifecycle: refresh (single-flighted, persists rotated refresh
// tokens BEFORE committing to memory), PKCE exchange, and the login-
// capture token swap. The auth URL + app credentials live here.
// tokenRetryBackoff is how long a failed refresh stays failed: expiresAt
// moves to now+this, so ensureToken retries once the window passes
// instead of hammering the token endpoint on every request.
const tokenRetryBackoff = 30 * time.Second

// tokenExpirySkew: tokens are treated as expired this far before the
// upstream expiry so a slow Pi never serves a token that dies mid-flight.
const tokenExpirySkew = 5 * time.Minute

const (
	authURL   = "https://oauth.secure.pixiv.net/auth/token"
	clientID  = "MOBrBDS8blbauoSck0ZfDbtuzpyT"
	clientSec = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj"
)

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
		c.expiresAt = time.Now().Add(tokenRetryBackoff)
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
		c.expiresAt = time.Now().Add(tokenRetryBackoff)
		c.mu.Unlock()
		// Auth-endpoint errors log STATUS ONLY (reviewer finding):
		// token-endpoint bodies can echo identifiers and must never
		// reach the journal. Feeds keep their truncated bodies.
		return fmt.Errorf("auth returned %d", resp.StatusCode)
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
			c.expiresAt = time.Now().Add(tokenRetryBackoff)
			c.mu.Unlock()
			return fmt.Errorf("persist rotated refresh token: %w", err)
		}
	}

	c.mu.Lock()
	c.accessToken = tr.AccessToken
	c.expiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second).Add(-tokenExpirySkew)
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
		// Auth-endpoint errors log STATUS ONLY (reviewer finding) — see
		// the refresh() error path for the rationale.
		return "", "", 0, fmt.Errorf("pkce exchange returned %d", resp.StatusCode)
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
	c.expiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second).Add(-tokenExpirySkew)
	c.mu.Unlock()
	return UpdateEnvFile(map[string]string{
		"PIXIV_REFRESH_TOKEN": refreshToken,
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

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}
