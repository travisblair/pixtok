package pixiv

import (
	"net/http"
	"testing"
	"time"
)

// Regression (review 1017-1 F-14): Go's decoder treats a missing key as
// the zero value and returns no error, so a 200 carrying an error
// envelope (or a truncated/shape-changed body) was cached as
// is_followed=false for the whole TTL — every already-followed artist
// rendered as "Follow".
func TestIsFollowedRefusesMissingPayload(t *testing.T) {
	for _, body := range []string{`{"error":true,"message":"rate limited"}`, `{}`} {
		rt := &countTransport{status: 200, respBody: body}
		c := &Client{
			expiresAt:   time.Now().Add(time.Hour),
			http:        &http.Client{Transport: rt},
			followState: newFollowStateCache(time.Minute),
		}
		if _, err := c.IsFollowed("12345"); err == nil {
			t.Fatalf("IsFollowed(%s) returned no error — a missing payload became 'not followed'", body)
		}
		if _, err := c.IsFollowed("12345"); err == nil {
			t.Fatalf("IsFollowed(%s) returned no error on the second call", body)
		}
		if rt.count() != 2 {
			t.Fatalf("IsFollowed(%s): upstream calls = %d, want 2 (the failure must not be cached)", body, rt.count())
		}
	}

	// An explicit false is data, not a missing field.
	rt := &countTransport{status: 200, respBody: `{"user":{"is_followed":false}}`}
	c := &Client{
		expiresAt:   time.Now().Add(time.Hour),
		http:        &http.Client{Transport: rt},
		followState: newFollowStateCache(time.Minute),
	}
	if v, err := c.IsFollowed("12345"); err != nil || v {
		t.Fatalf("explicit false = %v, %v", v, err)
	}
}

// Same contract for the bookmark walk: a 200 without illusts used to
// produce an empty id list with nil error, which the cache then served
// for 5 minutes — every like looked unliked until the TTL.
func TestGetBookmarkIDsRefusesMissingPayload(t *testing.T) {
	for _, body := range []string{`{"error":true}`, `{}`} {
		rt := &countTransport{status: 200, respBody: body}
		c := &Client{
			phpSessID: "123456_a",
			expiresAt: time.Now().Add(time.Hour),
			http:      &http.Client{Transport: rt},
		}
		if _, err := c.GetBookmarkIDs("public", 1); err == nil {
			t.Fatalf("GetBookmarkIDs(%s) returned no error — a missing payload became an empty list", body)
		}
	}

	// A legitimately empty list is not an error.
	rt := &countTransport{status: 200, respBody: `{"illusts":[],"next_url":""}`}
	c := &Client{
		phpSessID: "123456_a",
		expiresAt: time.Now().Add(time.Hour),
		http:      &http.Client{Transport: rt},
	}
	ids, err := c.GetBookmarkIDs("public", 1)
	if err != nil {
		t.Fatalf("empty bookmark list: %v", err)
	}
	if len(ids) != 0 {
		t.Fatalf("empty bookmark list returned %v", ids)
	}

	// A null work id must never reach the client (it normalizes to 0).
	rt = &countTransport{status: 200, respBody: `{"illusts":[{"id":null},{"id":"5"}],"next_url":""}`}
	c = &Client{
		phpSessID: "123456_a",
		expiresAt: time.Now().Add(time.Hour),
		http:      &http.Client{Transport: rt},
	}
	ids, err = c.GetBookmarkIDs("public", 1)
	if err != nil {
		t.Fatalf("null id: %v", err)
	}
	if len(ids) != 1 || ids[0] != "5" {
		t.Fatalf("null id produced %v, want just [5]", ids)
	}
}
