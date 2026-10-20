package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// Regression (review 1017-1 F-04): pixiv's web AJAX family answers
// HTTP 200 with {"error":true} for an expired session or a rate limit.
// These three transforms only modelled `body`, so that envelope decoded
// to a zero body and was returned as a successful EMPTY feed — the phone
// showed "no works" and the journal recorded no failure, while the rest
// of the file (street, search, bookmarks) already handled the envelope.
func TestTransformsRejectUpstreamErrorEnvelope(t *testing.T) {
	const envelope = `{"error":true,"message":"please log in again"}`

	cases := []struct {
		name string
		call func() error
	}{
		{"top illust", func() error { _, err := transformTopIllust([]byte(envelope)); return err }},
		{"newest", func() error { _, err := transformNewest([]byte(envelope), false); return err }},
		{"work recommend", func() error { _, err := transformWorkRecommend([]byte(envelope)); return err }},
		{"street", func() error { _, err := transformStreet([]byte(envelope)); return err }},
	}
	for _, tc := range cases {
		err := tc.call()
		if err == nil {
			t.Fatalf("%s: 200 {\"error\":true} became an empty feed instead of an error", tc.name)
		}
		if !strings.Contains(err.Error(), "please log in again") {
			t.Fatalf("%s: error %q dropped pixiv's message", tc.name, err)
		}
	}

	// An envelope without a message still fails, with a usable default.
	if _, err := transformNewest([]byte(`{"error":true}`), false); err == nil {
		t.Fatal("newest accepted an error envelope with no message")
	}

	// A legitimate empty page must keep working: error handling must not
	// turn offline-able empty feeds into 500s.
	for _, tc := range []struct {
		name string
		raw  string
	}{
		{"top illust", `{"error":false,"body":{"thumbnails":{"illust":[]},"tagTranslation":{}}}`},
		{"newest", `{"error":false,"message":"","body":{"illusts":[],"lastId":""}}`},
		{"work recommend", `{"error":false,"body":{"illusts":[]}}`},
	} {
		var err error
		switch tc.name {
		case "top illust":
			_, err = transformTopIllust([]byte(tc.raw))
		case "newest":
			_, err = transformNewest([]byte(tc.raw), false)
		default:
			_, err = transformWorkRecommend([]byte(tc.raw))
		}
		if err != nil {
			t.Fatalf("%s: legitimate empty page failed: %v", tc.name, err)
		}
	}
}

// Regression (review 1017-1 F-05): transformSearchUsers emitted
// "users":null for a zero-result artist search and "previews":null when
// a user had no workIds entry. The search screen dereferences both
// unguarded (users().length, u.previews.slice), so typing gibberish in
// Artists mode crashed the screen instead of showing "no results".
func TestSearchUsersEmitsEmptyArraysNotNull(t *testing.T) {
	out, err := transformSearchUsers([]byte(`{"error":false,"body":{"users":[],"thumbnails":{"illust":[]},"page":{"workIds":{},"total":0}}}`))
	if err != nil {
		t.Fatalf("empty artist search: %v", err)
	}
	if out.Users == nil {
		t.Fatal("users is nil — marshals to null, which the search screen cannot read")
	}
	raw, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"users":null`) {
		t.Fatalf("empty artist search still emits users:null: %s", raw)
	}

	// A row whose user is absent from page.workIds must carry an empty
	// previews array, not null.
	out, err = transformSearchUsers([]byte(`{"error":false,"body":{
		"users":[{"userId":"42","name":"Alice"}],
		"thumbnails":{"illust":[]},
		"page":{"workIds":{},"total":1}}}`))
	if err != nil {
		t.Fatalf("artist search without workIds: %v", err)
	}
	if len(out.Users) != 1 {
		t.Fatalf("users = %d, want 1", len(out.Users))
	}
	if out.Users[0].Previews == nil {
		t.Fatal("previews is nil — marshals to null, and the row render calls u.previews.slice")
	}
	raw, err = json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"previews":null`) {
		t.Fatalf("row still emits previews:null: %s", raw)
	}

	// The populated case is unchanged.
	out, err = transformSearchUsers([]byte(`{"error":false,"body":{
		"users":[{"userId":"42","name":"Alice"}],
		"thumbnails":{"illust":[{"id":"7","userId":"42","url":"https://i.pximg.net/c/250x250_80_a2/img-master/img/1/7_p0_square1200.jpg"}]},
		"page":{"workIds":{"42":[{"id":"7","type":"illust"}]},"total":1}}}`))
	if err != nil {
		t.Fatalf("artist search with previews: %v", err)
	}
	if len(out.Users) != 1 || len(out.Users[0].Previews) != 1 || out.Users[0].Previews[0].ID != "7" {
		t.Fatalf("previews mapping broke: %+v", out.Users)
	}
}

// The empty-page shapes must still marshal to a non-nil illusts array —
// the wire contract the frontend depends on.
func TestEmptyFeedKeepsIllustsArray(t *testing.T) {
	out, err := transformTopIllust([]byte(`{"error":false,"body":{"thumbnails":{"illust":[]}}}`))
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Illusts json.RawMessage `json:"illusts"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if string(got.Illusts) != "[]" {
		t.Fatalf("illusts = %s, want []", got.Illusts)
	}
}
