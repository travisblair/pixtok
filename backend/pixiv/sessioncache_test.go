package pixiv

import (
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// accountTransport serves the two account-scoped app-API surfaces and
// counts each call, so a test can tell "answered from cache" apart from
// "went upstream under the new credentials".
type accountTransport struct {
	mu        sync.Mutex
	bookmarks int
	details   int
}

func (a *accountTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	var body string
	switch req.URL.Path {
	case "/v1/user/bookmarks/illust":
		a.bookmarks++
		body = `{"illusts":[{"id":"7"}],"next_url":""}`
	case "/v1/user/detail":
		a.details++
		body = `{"user":{"is_followed":true}}`
	default:
		return &http.Response{StatusCode: 404, Body: http.NoBody, Request: req}, nil
	}
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}, nil
}

func (a *accountTransport) counts() (bookmarks, details int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.bookmarks, a.details
}

// Regression (review 1017-1 F-06): both caches are keyed only by
// request shape / artist id, and the in-app login can pick a different
// account. Nothing invalidated them, so account A's liked ids and
// follow state were served to account B for a full TTL (and A's 429
// cooldown kept B's follow buttons hidden).
func TestSetTokensResetsAccountScopedCaches(t *testing.T) {
	t.Setenv("PIXTOK_ENV_FILE", filepath.Join(t.TempDir(), ".env"))
	rt := &accountTransport{}
	c := &Client{
		phpSessID:   "123456_a",
		expiresAt:   time.Now().Add(time.Hour),
		http:        &http.Client{Transport: rt},
		followState: newFollowStateCache(time.Minute),
		bookmarkIDs: newBookmarkIDsCache(time.Minute),
	}

	if ok, err := c.IsFollowed("999"); err != nil || !ok {
		t.Fatalf("warm IsFollowed = %v, %v", ok, err)
	}
	if ids, err := c.CachedBookmarkIDs("public", 1); err != nil || len(ids) != 1 {
		t.Fatalf("warm CachedBookmarkIDs = %v, %v", ids, err)
	}
	c.followCooldown.Store(time.Now().Add(time.Hour).UnixNano())

	if err := c.SetTokens("rt-b", "acc-b", 3600); err != nil {
		t.Fatalf("SetTokens: %v", err)
	}

	if _, err := c.CachedBookmarkIDs("public", 1); err != nil {
		t.Fatalf("post-login CachedBookmarkIDs: %v", err)
	}
	if _, err := c.IsFollowed("999"); err != nil {
		t.Fatalf("post-login IsFollowed: %v", err)
	}
	bookmarkWalks, detailCalls := rt.counts()
	if bookmarkWalks != 2 {
		t.Fatalf("bookmark walks = %d, want 2 — account A's ids survived the login", bookmarkWalks)
	}
	if detailCalls != 2 {
		t.Fatalf("follow-state calls = %d, want 2 — account A's follow state survived the login", detailCalls)
	}
	if until := c.followCooldown.Load(); until != 0 {
		t.Fatalf("follow cooldown = %d, want cleared", until)
	}
}

func TestSetWebSessionResetsAccountScopedCaches(t *testing.T) {
	t.Setenv("PIXTOK_ENV_FILE", filepath.Join(t.TempDir(), ".env"))
	rt := &accountTransport{}
	c := &Client{
		phpSessID:   "123456_a",
		expiresAt:   time.Now().Add(time.Hour),
		http:        &http.Client{Transport: rt},
		bookmarkIDs: newBookmarkIDsCache(time.Minute),
	}

	if ids, err := c.CachedBookmarkIDs("public", 1); err != nil || len(ids) != 1 {
		t.Fatalf("warm CachedBookmarkIDs = %v, %v", ids, err)
	}
	// The bookmark walk's uid comes from the PHPSESSID prefix: a new web
	// session can mean a new account even when the app token is unchanged.
	if err := c.SetWebSession("654321_b", "tok-b"); err != nil {
		t.Fatalf("SetWebSession: %v", err)
	}
	if _, err := c.CachedBookmarkIDs("public", 1); err != nil {
		t.Fatalf("post-login CachedBookmarkIDs: %v", err)
	}
	if walks, _ := rt.counts(); walks != 2 {
		t.Fatalf("bookmark walks = %d, want 2 — the previous session's ids survived", walks)
	}
}
