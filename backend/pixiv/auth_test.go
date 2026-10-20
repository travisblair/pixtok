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
