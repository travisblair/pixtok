package main

// Cookie expiry preservation (review finding L9). rewriteCookie used to
// strip Max-Age/Expires, so pixiv's logout cookie (`PHPSESSID=;
// Max-Age=0`) was rewritten into a LIVE session cookie on our origin.

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// parsed returns the rewritten cookie re-parsed the way a browser reads
// it — the invariant is about the COOKIE, not the string.
func parsed(t *testing.T, setCookie string, secure bool) *http.Cookie {
	t.Helper()
	got := rewriteCookie(setCookie, secure)
	if got == "" {
		t.Fatalf("rewriteCookie(%q) dropped the cookie", setCookie)
	}
	c, err := http.ParseSetCookie(got)
	if err != nil {
		t.Fatalf("rewritten cookie %q does not re-parse: %v", got, err)
	}
	return c
}

func isDeletion(c *http.Cookie) bool {
	if c.MaxAge < 0 {
		return true
	}
	return !c.Expires.IsZero() && c.Expires.Before(time.Now())
}

func TestRewriteCookieKeepsMaxAgeDeletion(t *testing.T) {
	c := parsed(t, "PHPSESSID=; Max-Age=0; Path=/; HttpOnly", false)
	if !isDeletion(c) {
		t.Fatalf("Max-Age=0 logout became a live cookie: MaxAge=%d Expires=%v", c.MaxAge, c.Expires)
	}
	if !strings.Contains(strings.ToLower(rewriteCookie("PHPSESSID=; Max-Age=0", false)), "max-age=0") {
		t.Fatal("Max-Age=0 not present in the rewritten header")
	}
}

func TestRewriteCookieKeepsExpiresDeletion(t *testing.T) {
	const past = "Thu, 01 Jan 1970 00:00:00 GMT"
	c := parsed(t, "PHPSESSID=; Expires="+past+"; Path=/", false)
	if !isDeletion(c) {
		t.Fatalf("past-Expires logout became a live cookie: MaxAge=%d Expires=%v", c.MaxAge, c.Expires)
	}
}

func TestRewriteCookieKeepsRealTTL(t *testing.T) {
	c := parsed(t, "PHPSESSID=abc; Max-Age=3600; Path=/; HttpOnly; Secure", true)
	if c.MaxAge != 3600 {
		t.Fatalf("Max-Age lost: %d", c.MaxAge)
	}
	if c.Value != "abc" || !c.HttpOnly || !c.Secure || c.Path != "/" {
		t.Fatalf("cookie attributes damaged: %+v", c)
	}
	if c.Domain != "" {
		t.Fatalf("Domain= survived: %q", c.Domain)
	}
}

func TestRewriteCookieDeletionStaysHostScoped(t *testing.T) {
	// Deleting must still target OUR origin, not pixiv's.
	c := parsed(t, "PHPSESSID=; Domain=.pixiv.net; Max-Age=0; Path=/", false)
	if c.Domain != "" {
		t.Fatalf("Domain= survived on a deletion cookie: %q", c.Domain)
	}
	if !isDeletion(c) {
		t.Fatal("deletion lost while stripping Domain")
	}
}
