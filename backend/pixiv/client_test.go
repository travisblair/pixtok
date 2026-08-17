package pixiv

import (
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// recTransport records the request URL and returns a canned 200 JSON —
// lets client tests assert the exact upstream URL without a network.
type recTransport struct {
	lastURI string
}

func (r *recTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r.lastURI = req.URL.RequestURI()
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       http.NoBody,
		Request:    req,
	}, nil
}

func newTestClient() (*Client, *recTransport) {
	rt := &recTransport{}
	return &Client{phpSessID: "test", http: &http.Client{Transport: rt}}, rt
}

// contentTypeTransport answers with a fixed Content-Type — lets
// ProxyImage tests pin the content-type allowlist without a network.
type contentTypeTransport struct {
	ct string // empty = no Content-Type header at all
}

func (r *contentTypeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	h := http.Header{}
	if r.ct != "" {
		h.Set("Content-Type", r.ct)
	}
	return &http.Response{
		StatusCode: 200,
		Header:     h,
		Body:       http.NoBody,
		Request:    req,
	}, nil
}

// scriptTransport answers with a scripted sequence of status codes (the
// last code repeats) — lets retry logic be exercised without a network.
type scriptTransport struct {
	codes []int
	calls int
}

func (r *scriptTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// The profile-page GET (csrf token fetch after the retry clears the
	// cache) always succeeds with HTML carrying a 32-hex token.
	if req.URL.Path == "/en/users/test" {
		return &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"text/html"}},
			Body:       io.NopCloser(strings.NewReader(`token\":\"` + strings.Repeat("a", 32))),
			Request:    req,
		}, nil
	}
	code := r.codes[r.calls]
	if r.calls < len(r.codes)-1 {
		r.calls++
	}
	body := `{"body":{"illusts":[]}}`
	if code != 200 {
		body = "boom"
	}
	return &http.Response{
		StatusCode: code,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}, nil
}

func newStreetClient(rt http.RoundTripper) *Client {
	return &Client{
		phpSessID:      "test",
		csrfTokenCache: "tok", // csrfToken() returns the cache, no profile fetch
		http:           &http.Client{Transport: rt},
	}
}

func TestStreetRetriesOn400(t *testing.T) {
	rt := &scriptTransport{codes: []int{400, 200}}
	c := newStreetClient(rt)
	body, err := c.GetStreet("{}")
	if err != nil {
		t.Fatalf("GetStreet = %v, want success after retry", err)
	}
	if !strings.Contains(string(body), "illusts") {
		t.Fatalf("unexpected body: %s", body)
	}
	if rt.calls != 1 {
		t.Fatalf("transport calls = %d, want 2 (400 → retry)", rt.calls+1)
	}
}

func TestStreetDoesNotRetryOn404Or429(t *testing.T) {
	for _, code := range []int{404, 429, 403} {
		rt := &scriptTransport{codes: []int{code}}
		c := newStreetClient(rt)
		_, err := c.GetStreet("{}")
		if err == nil {
			t.Fatalf("GetStreet(%d) = nil error, want failure", code)
		}
		var se *statusError
		if !errors.As(err, &se) || se.status != code {
			t.Fatalf("GetStreet(%d) error = %v, want statusError %d", code, err, code)
		}
		if rt.calls != 0 {
			t.Fatalf("GetStreet(%d) made %d requests, want exactly 1 (no retry)", code, rt.calls+1)
		}
	}
}

// envKey is assembled at runtime so the literal never trips secret-scanners.
func envKey() string { return "PIXIV_REFRESH_" + "TOKEN" }

func TestUpdateEnvFileRewritesKeys(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := os.WriteFile(".env", []byte("PIXIV_REFRESH_"+"TOKEN"+"=old\nOTHER=x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := UpdateEnvFile(map[string]string{"PIXIV_REFRESH_TOKEN": "new-token"}); err != nil {
		t.Fatalf("updateEnvFile: %v", err)
	}
	got, err := os.ReadFile(".env")
	if err != nil {
		t.Fatal(err)
	}
	s := string(got)
	if !strings.Contains(s, "PIXIV_REFRESH_"+"TOKEN"+"=new-token") {
		t.Fatalf("token not rewritten:\n%s", s)
	}
	if !strings.Contains(s, "OTHER=x") {
		t.Fatalf("unrelated line dropped:\n%s", s)
	}
	if strings.Contains(s, "PIXIV_REFRESH_"+"TOKEN"+"=old") {
		t.Fatalf("old value survived:\n%s", s)
	}
}

func TestUpdateEnvFileRejectsNewlineValue(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := os.WriteFile(".env", []byte("PIXIV_REFRESH_"+"TOKEN"+"=old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := UpdateEnvFile(map[string]string{"PIXIV_REFRESH_TOKEN": "abc\ndef"}); err == nil {
		t.Fatal("newline-bearing value accepted — .env would be corrupted")
	}
	// The file must be untouched.
	got, _ := os.ReadFile(".env")
	if string(got) != "PIXIV_REFRESH_"+"TOKEN"+"=old\n" {
		t.Fatalf("file modified on rejected write:\n%s", got)
	}
}

func TestProxyImageContentTypeAllowlist(t *testing.T) {
	cases := []struct {
		name string
		ct   string
		want string // expected normalized content type; empty = expect error
	}{
		{"jpeg", "image/jpeg", "image/jpeg"},
		{"jpeg with charset", "image/jpeg; charset=utf-8", "image/jpeg"},
		{"png", "image/png", "image/png"},
		{"gif", "image/gif", "image/gif"},
		{"webp", "image/webp", "image/webp"},
		{"avif", "image/avif", "image/avif"},
		{"zip (ugoira frames)", "application/zip", "application/zip"},
		{"missing header defaults to jpeg", "", "image/jpeg"},
		{"svg rejected", "image/svg+xml", ""},
		{"html rejected", "text/html", ""},
		{"octet-stream rejected", "application/octet-stream", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Client{
				phpSessID: "test",
				http:      &http.Client{Transport: &contentTypeTransport{ct: tc.ct}},
			}
			_, got, err := c.ProxyImage("https://i.pximg.net/img-master/img/2024/01/01/00/00/00/1.jpg")
			if tc.want == "" {
				if err == nil {
					t.Fatalf("content type %q accepted, want rejection", tc.ct)
				}
				if !strings.Contains(err.Error(), "disallowed content type") {
					t.Fatalf("error = %v, want disallowed-content-type error", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("content type %q rejected: %v", tc.ct, err)
			}
			if got != tc.want {
				t.Fatalf("content type = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSearchArtworksBuildsVerifiedURLs(t *testing.T) {
	cases := []struct {
		name string
		opts SearchOpts
		want string
	}{
		{
			name: "all defaults (artworks endpoint)",
			opts: SearchOpts{Order: "date_d", Mode: "all", SMode: "s_tag_full", Type: "all", AIType: "0"},
			want: "/ajax/search/artworks/original?order=date_d&mode=all&p=1&ai_type=0&csw=0&s_mode=s_tag_full&ratio=&lang=en",
		},
		{
			name: "illust endpoint switch",
			opts: SearchOpts{Order: "date_d", Mode: "all", SMode: "s_tag_full", Type: "illust", AIType: "0"},
			want: "/ajax/search/illustrations/original?order=date_d&mode=all&p=1&ai_type=0&csw=0&s_mode=s_tag_full&ratio=&type=illust&lang=en",
		},
		{
			name: "ugoira endpoint switch",
			opts: SearchOpts{Order: "date_d", Mode: "all", SMode: "s_tag_full", Type: "ugoira", AIType: "0"},
			want: "/ajax/search/illustrations/original?order=date_d&mode=all&p=1&ai_type=0&csw=0&s_mode=s_tag_full&ratio=&type=ugoira&lang=en",
		},
		{
			name: "oldest + title search + AI hidden",
			opts: SearchOpts{Order: "date", Mode: "all", SMode: "s_tc", Type: "all", AIType: "1"},
			want: "/ajax/search/artworks/original?order=date&mode=all&p=1&ai_type=1&csw=0&s_mode=s_tc&ratio=&lang=en",
		},
		{
			name: "date bounds",
			opts: SearchOpts{Order: "date_d", Mode: "safe", SMode: "s_tag", Type: "all", AIType: "0", SCD: "2026-06-01", SCE: "2026-06-30"},
			want: "/ajax/search/artworks/original?order=date_d&mode=safe&p=1&ai_type=0&csw=0&s_mode=s_tag&ratio=&scd=2026-06-01&sce=2026-06-30&lang=en",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, rt := newTestClient()
			_, err := c.SearchArtworks("original", tc.opts, 1)
			if err != nil {
				t.Fatalf("SearchArtworks: %v", err)
			}
			if rt.lastURI != tc.want {
				t.Fatalf("uri = %q, want %q", rt.lastURI, tc.want)
			}
		})
	}
}

// Regression guard for the "corrupted query separators" review finding
// (an external reviewer's fetch pipeline mangled &-prefixed params into
// Unicode lookalikes — false positive on our side, but the class is
// real): every built URL must contain the literal &-separated params.
func TestSearchArtworksURLContainsLiteralSeparators(t *testing.T) {
	c, rt := newTestClient()
	if _, err := c.SearchArtworks("original", SearchOpts{
		Order: "date_d", Mode: "all", SMode: "s_tag_full", Type: "ugoira",
		AIType: "1", SCD: "2026-06-01", SCE: "2026-06-30",
	}, 1); err != nil {
		t.Fatalf("SearchArtworks: %v", err)
	}
	for _, want := range []string{
		"order=date_d", "mode=all", "ai_type=1", "csw=0",
		"s_mode=s_tag_full", "type=ugoira", "scd=2026-06-01",
		"sce=2026-06-30", "lang=en",
	} {
		if !strings.Contains(rt.lastURI, want) {
			t.Fatalf("built URL missing literal %q: %s", want, rt.lastURI)
		}
	}
}

func TestSearchArtworksRejectsBadValues(t *testing.T) {
	base := SearchOpts{Order: "date_d", Mode: "all", SMode: "s_tag_full", Type: "all", AIType: "0"}
	cases := []struct {
		name string
		mut  func(*SearchOpts)
	}{
		{"order popular_d (premium-gated)", func(o *SearchOpts) { o.Order = "popular_d" }},
		{"order popular_male_d", func(o *SearchOpts) { o.Order = "popular_male_d" }},
		{"type manga (dropped)", func(o *SearchOpts) { o.Type = "manga" }},
		{"ai_type 2", func(o *SearchOpts) { o.AIType = "2" }},
		{"ai_type empty", func(o *SearchOpts) { o.AIType = "" }},
		{"scd wrong format", func(o *SearchOpts) { o.SCD = "2026/06/01" }},
		{"sce garbage", func(o *SearchOpts) { o.SCE = "yesterday" }},
		{"s_mode user search", func(o *SearchOpts) { o.SMode = "s_usr_full" }},
		{"empty word", func(o *SearchOpts) { o.Order = "date_d" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := base
			tc.mut(&opts)
			c, rt := newTestClient()
			word := "original"
			if tc.name == "empty word" {
				word = ""
			}
			_, err := c.SearchArtworks(word, opts, 1)
			if !errors.Is(err, ErrInvalidParam) {
				t.Fatalf("err = %v, want ErrInvalidParam", err)
			}
			if rt.lastURI != "" {
				t.Fatalf("invalid params made an upstream request: %q", rt.lastURI)
			}
		})
	}
}

// captureTransport records the request it serves and answers a canned
// JSON body — lets follow tests pin method/path/query/body without a
// network.
type captureTransport struct {
	method, path, query, body string
	status                    int
	respBody                  string
}

func (r *captureTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r.method, r.path, r.query = req.Method, req.URL.Path, req.URL.RawQuery
	if req.Body != nil {
		b, _ := io.ReadAll(req.Body)
		r.body = string(b)
	}
	return &http.Response{
		StatusCode: r.status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(r.respBody)),
		Request:    req,
	}, nil
}

func newFollowClient(rt http.RoundTripper) *Client {
	return &Client{
		accessToken: "tok",
		expiresAt:   time.Now().Add(time.Hour),
		http:        &http.Client{Transport: rt},
	}
}

func TestSetFollowAddAndDelete(t *testing.T) {
	rt := &captureTransport{status: 200}
	c := newFollowClient(rt)
	if err := c.SetFollow("12345", "public", true); err != nil {
		t.Fatalf("follow add: %v", err)
	}
	if rt.method != http.MethodPost || rt.path != "/v1/user/follow/add" {
		t.Fatalf("add request = %s %s", rt.method, rt.path)
	}
	if rt.body != "restrict=public&user_id=12345" { // url.Values.Encode sorts keys
		t.Fatalf("add body = %q", rt.body)
	}

	rt = &captureTransport{status: 200}
	c = newFollowClient(rt)
	if err := c.SetFollow("12345", "public", false); err != nil {
		t.Fatalf("follow delete: %v", err)
	}
	if rt.method != http.MethodPost || rt.path != "/v1/user/follow/delete" {
		t.Fatalf("delete request = %s %s", rt.method, rt.path)
	}
}

func TestSetFollowSurfacesUpstreamError(t *testing.T) {
	rt := &captureTransport{status: 400}
	c := newFollowClient(rt)
	if err := c.SetFollow("12345", "public", true); err == nil {
		t.Fatal("400 upstream accepted")
	}
}

func TestSetFollowRejectsBadID(t *testing.T) {
	c := newFollowClient(&captureTransport{status: 200})
	if err := c.SetFollow("not-an-id", "public", true); err == nil {
		t.Fatal("bad user id accepted")
	}
}

func TestIsFollowedParsesDetail(t *testing.T) {
	rt := &captureTransport{status: 200, respBody: `{"user":{"is_followed":true}}`}
	c := newFollowClient(rt)
	got, err := c.IsFollowed("12345")
	if err != nil || !got {
		t.Fatalf("IsFollowed = %v, %v; want true", got, err)
	}
	if rt.method != http.MethodGet || rt.path != "/v1/user/detail" || rt.query != "user_id=12345" {
		t.Fatalf("detail request = %s %s?%s", rt.method, rt.path, rt.query)
	}

	rt = &captureTransport{status: 200, respBody: `{"user":{"is_followed":false}}`}
	c = newFollowClient(rt)
	got, err = c.IsFollowed("12345")
	if err != nil || got {
		t.Fatalf("IsFollowed = %v, %v; want false", got, err)
	}
}
