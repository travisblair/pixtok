package pixiv

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A web-session swap whose .env write fails must leave the running
// client on the OLD session. Committing memory first (the old code) let
// the process run on a session disk had never seen; after a restart the
// resurrected, dead PHPSESSID broke every web-AJAX surface.
func TestSetWebSessionDoesNotSwapWhenPersistenceFails(t *testing.T) {
	// A directory at the env path makes the read/modify/write fail
	// before anything can be persisted.
	t.Setenv("PIXTOK_ENV_FILE", t.TempDir())

	c := &Client{}
	c.setWebCache("123456_old", "old-token")

	if err := c.SetWebSession("123456_new", "new-token"); err == nil {
		t.Fatal("SetWebSession succeeded with an unwritable .env")
	}
	if sess, tok := c.webSession(); sess != "123456_old" || tok != "old-token" {
		t.Fatalf("memory swapped to (%q, %q) despite a failed persist — memory is ahead of disk", sess, tok)
	}
}

func TestSetWebSessionPersistsBothKeys(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")
	t.Setenv("PIXTOK_ENV_FILE", envPath)

	c := &Client{}
	c.setWebCache("123456_old", "old-token")
	if err := c.SetWebSession("123456_new", "new-token"); err != nil {
		t.Fatalf("SetWebSession: %v", err)
	}
	if sess, tok := c.webSession(); sess != "123456_new" || tok != "new-token" {
		t.Fatalf("memory = (%q, %q), want the new session", sess, tok)
	}
	raw, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"PIXIV_PHPSESSID=123456_new", "PIXTOK_CSRF_TOKEN=new-token"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf(".env missing %q:\n%s", want, raw)
		}
	}
}

// Regression (review 1017-1 F-11): the csrf token and the PHPSESSID
// were read in two separate lock acquisitions, so a login capture
// landing between them paired session A's token with session B's
// cookie — pixiv 400s that, and the request is wasted. The token also
// carries its session, and callers must use THAT session for the
// cookie (and for the uid in the URL).
func TestWebCallsPairCsrfTokenWithItsOwnSession(t *testing.T) {
	token := strings.Repeat("a", 32)

	t.Run("street", func(t *testing.T) {
		rt := &csrfSwapTransport{token: token, swapTo: [2]string{"654321_b", "tok-b"}}
		c := &Client{phpSessID: "123456_a", http: &http.Client{Transport: rt}}
		rt.client = c

		if _, err := c.GetStreet("{}"); err != nil {
			t.Fatalf("GetStreet: %v", err)
		}
		if rt.lastCSRF != token {
			t.Fatalf("x-csrf-token = %q, want the token scraped for the session", rt.lastCSRF)
		}
		if rt.lastCookie != "PHPSESSID=123456_a" {
			t.Fatalf("Cookie = %q — the POST paired session A's token with another session's cookie", rt.lastCookie)
		}
	})

	t.Run("bookmarks page uid", func(t *testing.T) {
		rt := &csrfSwapTransport{token: token, swapTo: [2]string{"654321_b", "tok-b"}}
		c := &Client{phpSessID: "123456_a", http: &http.Client{Transport: rt}}
		rt.client = c

		if _, err := c.GetBookmarkPage("", 0, 20, "desc"); err != nil {
			t.Fatalf("GetBookmarkPage: %v", err)
		}
		if !strings.Contains(rt.lastPath, "/ajax/user/123456/") {
			t.Fatalf("bookmarks URL = %q, want the uid of the session that signs the call", rt.lastPath)
		}
		if rt.lastCookie != "PHPSESSID=123456_a" {
			t.Fatalf("Cookie = %q, want the same session as the uid in the URL", rt.lastCookie)
		}
	})
}

// csrfSwapTransport answers the profile-page token scrape, then swaps the
// live web session BEFORE answering the AJAX call — the login-capture
// race in its worst order.
type csrfSwapTransport struct {
	client     *Client
	swapTo     [2]string
	token      string
	lastPath   string
	lastCSRF   string
	lastCookie string
}

func (t *csrfSwapTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.lastPath = req.URL.Path
	if strings.HasPrefix(req.URL.Path, "/en/users/") {
		t.client.setWebCache(t.swapTo[0], t.swapTo[1])
		return fsJSON(req, `token\":\"`+t.token+`"`), nil
	}
	t.lastCSRF = req.Header.Get("x-csrf-token")
	t.lastCookie = req.Header.Get("Cookie")
	return fsJSON(req, `{"error":false,"body":{"contents":[],"illusts":[],"works":[],"total":0},"illusts":[]}`), nil
}

// Regression (review 1017-1 F-13): the ugoira-meta and recs handlers
// already map ErrNotFound to 404, but neither method ever produced it —
// a deleted work answered 502 "upstream error", which clients retry for
// a permanent condition.
func TestWorkDetailMethodsWrapNotFound(t *testing.T) {
	cases := []struct {
		name string
		call func(*Client) error
	}{
		{"ugoira meta", func(c *Client) error { _, err := c.GetUgoiraMeta("123"); return err }},
		{"work recommend", func(c *Client) error { _, err := c.GetWorkRecommend("123"); return err }},
	}
	for _, tc := range cases {
		c := newStreetClient(&countTransport{status: 404, respBody: "not found"})
		if err := tc.call(c); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s: err = %v, want ErrNotFound", tc.name, err)
		}
	}

	// A transient failure must stay an upstream error, not a 404.
	c := newStreetClient(&countTransport{status: 500, respBody: "boom"})
	if _, err := c.GetUgoiraMeta("123"); errors.Is(err, ErrNotFound) {
		t.Fatal("a 500 was reported as not found")
	}
	if _, err := c.GetWorkRecommend("123"); errors.Is(err, ErrNotFound) {
		t.Fatal("a 500 was reported as not found")
	}
}
