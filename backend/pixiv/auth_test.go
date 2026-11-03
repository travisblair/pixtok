package pixiv

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// heldTokenTransport answers the token endpoint with a valid rotation and
// parks the FIRST request until release is closed — lets a test keep a
// refresh mid-flight while another token writer runs.
type heldTokenTransport struct {
	entered chan struct{}
	release chan struct{}
	rotated string

	mu    sync.Mutex
	calls int
}

func (t *heldTokenTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	t.calls++
	first := t.calls == 1
	t.mu.Unlock()
	if first {
		close(t.entered)
	}
	<-t.release
	body := fmt.Sprintf(`{"access_token":"old-account-access","refresh_token":%q,"expires_in":3600}`, t.rotated)
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}, nil
}

// Regression (review 1017-1 F-01): a refresh already in flight when the
// user logs in used to commit the PREVIOUS account's rotated token after
// SetTokens — reverting the login on disk and in memory, so the app kept
// (or resurrected on restart) the old account. SetTokens must queue
// behind that refresh and stay the last writer.
func TestSetTokensSerializesAgainstInflightRefresh(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")
	t.Setenv("PIXTOK_ENV_FILE", envPath)
	if err := os.WriteFile(envPath, []byte(envKey()+"=old-account\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	rt := &heldTokenTransport{
		entered: make(chan struct{}),
		release: make(chan struct{}),
		rotated: "old-account-rotated",
	}
	c := &Client{refreshToken: "old-account", http: &http.Client{Transport: rt}}

	refreshDone := make(chan error, 1)
	go func() { refreshDone <- c.refresh() }()
	select {
	case <-rt.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("refresh never reached the token endpoint")
	}

	loginDone := make(chan error, 1)
	go func() { loginDone <- c.SetTokens("new-account", "new-access", 3600) }()

	// A login that returns while the refresh is parked means the two
	// token writers are unsynchronized.
	select {
	case <-loginDone:
		t.Fatal("SetTokens completed while a refresh was in flight — token writers are not serialized")
	case <-time.After(150 * time.Millisecond):
	}

	close(rt.release)
	if err := <-refreshDone; err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if err := <-loginDone; err != nil {
		t.Fatalf("SetTokens: %v", err)
	}

	c.mu.Lock()
	refreshToken, accessToken, expires := c.refreshToken, c.accessToken, c.expiresAt
	c.mu.Unlock()
	if refreshToken != "new-account" {
		t.Fatalf("in-memory refresh token = %q, want the login's %q", refreshToken, "new-account")
	}
	if accessToken != "new-access" {
		t.Fatalf("in-memory access token = %q, want %q", accessToken, "new-access")
	}
	if !expires.After(time.Now().Add(30 * time.Minute)) {
		t.Fatalf("access token expiry = %v, want a full lifetime", expires)
	}

	raw, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), envKey()+"=new-account") {
		t.Fatalf(".env holds the refresh result instead of the login:\n%s", raw)
	}
	if strings.Contains(string(raw), "old-account-rotated") {
		t.Fatalf(".env revived the pre-login refresh token:\n%s", raw)
	}
}

// Regression (review 1017-1 F-15): the old guard covered only
// expires_in <= 300, but the 5-minute skew is subtracted afterwards, so
// a 301..599s lifetime derived an expiresAt seconds-to-minutes out and
// every request re-entered the token endpoint (rotating the refresh
// token and rewriting .env each time).
func TestRefreshNormalizesPathologicalExpiresIn(t *testing.T) {
	for _, expiresIn := range []int{301, 599} {
		rt := &healthTransport{
			tokenBody: fmt.Sprintf(`{"access_token":"acc","refresh_token":"rot","expires_in":%d}`, expiresIn),
		}
		c := healthClient(t, rt)
		if err := c.refresh(); err != nil {
			t.Fatalf("expires_in %d: refresh: %v", expiresIn, err)
		}
		c.mu.Lock()
		ttl := time.Until(c.expiresAt)
		c.mu.Unlock()
		if ttl < 50*time.Minute {
			t.Fatalf("expires_in %d produced a %v token window — every request will re-refresh", expiresIn, ttl)
		}
		if err := c.ensureToken(); err != nil {
			t.Fatalf("expires_in %d: ensureToken: %v", expiresIn, err)
		}
		if rt.calls() != 1 {
			t.Fatalf("expires_in %d: token endpoint calls = %d after two requests, want 1", expiresIn, rt.calls())
		}
	}
}

func TestSetTokensNormalizesPathologicalExpiresIn(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")
	t.Setenv("PIXTOK_ENV_FILE", envPath)
	c := &Client{}
	if err := c.SetTokens("rt", "acc", 301); err != nil {
		t.Fatalf("SetTokens: %v", err)
	}
	c.mu.Lock()
	ttl := time.Until(c.expiresAt)
	c.mu.Unlock()
	if ttl < 50*time.Minute {
		t.Fatalf("expires_in 301 produced a %v token window", ttl)
	}
}

// healthTransport serves the token endpoint and the web health probe
// with scripted answers, keyed by host.
type healthTransport struct {
	tokenStatus int
	tokenBody   string
	webStatus   int
	webBody     string

	mu         sync.Mutex
	tokenCalls int
}

func (h *healthTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	status, body := h.webStatus, h.webBody
	if req.URL.Host == "oauth.secure.pixiv.net" {
		h.tokenCalls++
		status, body = h.tokenStatus, h.tokenBody
	}
	if status == 0 {
		status = 200
	}
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}, nil
}

func (h *healthTransport) calls() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.tokenCalls
}

func healthClient(t *testing.T, rt http.RoundTripper) *Client {
	t.Helper()
	t.Setenv("PIXTOK_ENV_FILE", filepath.Join(t.TempDir(), ".env"))
	return &Client{refreshToken: "rt", http: &http.Client{Transport: rt}}
}

// Regression (review 1017-1 F-03): refresh() short-circuits while
// expiresAt is in the future, so a status probe that called refresh()
// reported a revoked credential as healthy indefinitely. AuthHealth must
// ask the token endpoint.
func TestAuthHealthProbesTokenEndpointDespiteValidExpiry(t *testing.T) {
	rt := &healthTransport{
		tokenStatus: 400,
		tokenBody:   `{"error":"invalid_grant"}`,
		webBody:     `{"error":false,"body":{"user":{"id":"1"}}}`,
	}
	c := healthClient(t, rt)
	c.mu.Lock()
	c.expiresAt = time.Now().Add(time.Hour) // looks valid; the token is revoked
	c.mu.Unlock()

	appOK, webOK := c.AuthHealth()
	if appOK {
		t.Fatal("app_api reported healthy from a future expiresAt — the token endpoint was never asked")
	}
	if !webOK {
		t.Fatal("web_session should be healthy for this fixture")
	}
	if rt.calls() != 1 {
		t.Fatalf("token endpoint calls = %d, want 1", rt.calls())
	}
}

// Regression (review 1017-1 F-03): the web AJAX family answers 200 with
// {"error":true} for an expired session; a status check called that
// connected.
func TestAuthHealthRejectsWebErrorEnvelope(t *testing.T) {
	rt := &healthTransport{
		tokenBody: `{"access_token":"acc","refresh_token":"rot","expires_in":3600}`,
		webBody:   `{"error":true,"message":"please log in"}`,
	}
	c := healthClient(t, rt)

	appOK, webOK := c.AuthHealth()
	if !appOK {
		t.Fatal("app_api should be healthy for this fixture")
	}
	if webOK {
		t.Fatal("web_session reported healthy for a 200 {\"error\":true} envelope")
	}
}

func TestAuthHealthReportsHealthySurfaces(t *testing.T) {
	rt := &healthTransport{
		tokenBody: `{"access_token":"acc","refresh_token":"rot","expires_in":3600}`,
		webBody:   `{"error":false,"body":{"user":{"id":"1"}}}`,
	}
	c := healthClient(t, rt)

	if appOK, webOK := c.AuthHealth(); !appOK || !webOK {
		t.Fatalf("AuthHealth = (%v, %v), want (true, true)", appOK, webOK)
	}
}
