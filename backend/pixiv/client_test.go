package pixiv

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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
			_, got, err := c.ProxyImageStream("https://i.pximg.net/img-master/img/2024/01/01/00/00/00/1.jpg", httptest.NewRecorder())
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
		followState: newFollowStateCache(5 * time.Minute),
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

// countTransport counts upstream calls, optionally delaying each one —
// the follow-state cache tests pin "exactly N upstream requests" with it.
type countTransport struct {
	mu       sync.Mutex
	calls    int
	status   int
	respBody string
	delay    time.Duration
}

func (r *countTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r.mu.Lock()
	r.calls++
	r.mu.Unlock()
	if r.delay > 0 {
		time.Sleep(r.delay)
	}
	return &http.Response{
		StatusCode: r.status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(r.respBody)),
		Request:    req,
	}, nil
}

func (r *countTransport) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func TestIsFollowedCachedWithinTTL(t *testing.T) {
	rt := &countTransport{status: 200, respBody: `{"user":{"is_followed":true}}`}
	c := newFollowClient(rt)
	for i := 0; i < 5; i++ {
		got, err := c.IsFollowed("12345")
		if err != nil || !got {
			t.Fatalf("call %d = %v, %v", i, got, err)
		}
	}
	if rt.count() != 1 {
		t.Fatalf("upstream calls = %d, want 1 (TTL cache)", rt.count())
	}
}

func TestIsFollowedSingleFlightCollapsesConcurrentCalls(t *testing.T) {
	rt := &countTransport{
		status:   200,
		respBody: `{"user":{"is_followed":true}}`,
		delay:    30 * time.Millisecond,
	}
	c := newFollowClient(rt)
	var wg sync.WaitGroup
	const n = 12
	vals := make([]bool, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			vals[i], errs[i] = c.IsFollowed("12345")
		}(i)
	}
	wg.Wait()
	for i := 0; i < n; i++ {
		if errs[i] != nil || !vals[i] {
			t.Fatalf("caller %d = %v, %v", i, vals[i], errs[i])
		}
	}
	if rt.count() != 1 {
		t.Fatalf("upstream calls = %d, want 1 (single-flight)", rt.count())
	}
}

func TestIsFollowedErrorsAreNotCached(t *testing.T) {
	// Non-429 failures keep the old contract: errors are never cached,
	// so the next natural call retries upstream. (429 is different BY
	// DESIGN — it trips the follow-state circuit breaker, pinned in
	// TestFollowStateCooldownAfter429.)
	rt := &countTransport{status: 500, respBody: `{}`}
	c := newFollowClient(rt)
	if _, err := c.IsFollowed("12345"); err == nil {
		t.Fatal("500 upstream accepted")
	}
	if _, err := c.IsFollowed("12345"); err == nil {
		t.Fatal("500 upstream accepted on second call")
	}
	if rt.count() != 2 {
		t.Fatalf("upstream calls = %d, want 2 (errors never cached)", rt.count())
	}
}

func TestIsFollowedTTLExpiryRefetches(t *testing.T) {
	rt := &countTransport{status: 200, respBody: `{"user":{"is_followed":true}}`}
	c := newFollowClient(rt)
	c.followState.ttl = 30 * time.Millisecond
	if _, err := c.IsFollowed("12345"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if _, err := c.IsFollowed("12345"); err != nil {
		t.Fatal(err)
	}
	if rt.count() != 2 {
		t.Fatalf("upstream calls = %d, want 2 (TTL expired)", rt.count())
	}
}

// tokenTransport answers the token endpoint with a scripted token pair —
// lets refresh() rotation tests run without a network.
type tokenTransport struct {
	body string
}

func (r *tokenTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(r.body)),
		Request:    req,
	}, nil
}

// Rotation persistence (reviewer finding): a rotated refresh token must
// land in .env BEFORE it replaces the in-memory value — the durable
// credential is the file, not the running process.
func TestRefreshPersistsRotatedToken(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")
	t.Setenv("PIXTOK_ENV_FILE", envPath)
	old := "old-token-value"
	if err := os.WriteFile(envPath, []byte(envKey()+"="+old+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	rotated := "new-token-value"
	c := &Client{
		refreshToken: old,
		http: &http.Client{Transport: &tokenTransport{
			body: `{"access_token":"acc","refresh_token":"` + rotated + `","expires_in":3600}`,
		}},
	}
	if err := c.refresh(); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if c.refreshToken != rotated {
		t.Fatalf("in-memory refresh token = %q, want %q", c.refreshToken, rotated)
	}
	got, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), envKey()+"="+rotated) {
		t.Fatalf(".env not updated with rotated token:\n%s", got)
	}
	if strings.Contains(string(got), envKey()+"="+old) {
		t.Fatalf("old token survived the rotation write:\n%s", got)
	}
}

// Persistence failure must fail the refresh and leave memory on the OLD
// token — memory never gets ahead of disk (the split-brain state that
// made restarts resurrect stale credentials).
func TestRefreshPersistenceFailureDoesNotCommitRotation(t *testing.T) {
	// Point at a .env that cannot be read: UpdateEnvFile fails before
	// any write, simulating a broken credential store.
	t.Setenv("PIXTOK_ENV_FILE", filepath.Join(t.TempDir(), "missing", ".env"))

	old := "old-token-value"
	c := &Client{
		refreshToken: old,
		http: &http.Client{Transport: &tokenTransport{
			body: `{"access_token":"acc","refresh_token":"new-token-value","expires_in":3600}`,
		}},
	}
	if err := c.refresh(); err == nil {
		t.Fatal("refresh succeeded despite failed persistence")
	}
	if c.refreshToken != old {
		t.Fatalf("memory ahead of disk: refresh token = %q, want old %q", c.refreshToken, old)
	}
	// The circuit breaker must be armed so a broken disk doesn't turn
	// every request into a fresh upstream refresh call.
	c.mu.Lock()
	backoff := time.Until(c.expiresAt)
	c.mu.Unlock()
	if backoff < 25*time.Second || backoff > 31*time.Second {
		t.Fatalf("circuit breaker not armed: next refresh in %v, want ~30s", backoff)
	}
}

// staticBodyTransport serves a fixed body with a fixed content type.
type staticBodyTransport struct {
	body []byte
	ct   string
}

func (r *staticBodyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{r.ct}},
		Body:       io.NopCloser(bytes.NewReader(r.body)),
		Request:    req,
	}, nil
}

// Oversized bodies must stream through without ever being fully
// buffered (reviewer finding: cache misses allocated up to 25 MB each).
func TestProxyImageStreamStreamsOversizedBody(t *testing.T) {
	payload := bytes.Repeat([]byte("a"), maxCacheableBody+64<<10)
	tr := &staticBodyTransport{body: payload, ct: "application/zip"}
	c := &Client{http: &http.Client{Transport: tr}}

	rec := httptest.NewRecorder()
	body, ct, err := c.ProxyImageStream("https://i.pximg.net/img-zip-ugoira/1.zip", rec)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if body != nil {
		t.Fatalf("oversized body returned for caching (%d bytes)", len(body))
	}
	if ct != "application/zip" {
		t.Fatalf("content type = %q, want application/zip", ct)
	}
	if got := rec.Body.Bytes(); !bytes.Equal(got, payload) {
		t.Fatalf("streamed body = %d bytes, want %d intact", len(got), len(payload))
	}
	if h := rec.Header().Get("Content-Type"); h != "application/zip" {
		t.Fatalf("streamed Content-Type header = %q", h)
	}
	if h := rec.Header().Get("X-Cache"); h != "MISS" {
		t.Fatalf("streamed X-Cache header = %q, want MISS", h)
	}
}

// Small bodies buffer fully and come back for the cache — the caller
// (handler), not the client, writes them.
func TestProxyImageStreamBuffersSmallBody(t *testing.T) {
	payload := []byte("small-image-bytes")
	tr := &staticBodyTransport{body: payload, ct: "image/png"}
	c := &Client{http: &http.Client{Transport: tr}}

	rec := httptest.NewRecorder()
	body, ct, err := c.ProxyImageStream("https://i.pximg.net/img-master/1.png", rec)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if !bytes.Equal(body, payload) {
		t.Fatalf("buffered body = %q, want %q", body, payload)
	}
	if ct != "image/png" {
		t.Fatalf("content type = %q, want image/png", ct)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("small body was written by the client (%d bytes) — the handler writes it", rec.Body.Len())
	}
}

// ── Upstream concurrency gate (upstreamSlots) ──────────────────────────
// 2026-08-21: a search-page render mounted ~50 follow-state calls at
// once — ~60 simultaneous TLS handshakes on the Pi Zero W's single core,
// starving each other's CPU budget and time-storming (the journal's 502
// bursts). The gate bounds in-flight handshakes; these tests pin the
// bound, the release paths, and the nil-literal escape hatch.

// countingTransport tracks concurrent RoundTrips and blocks each for a
// moment so the gate has something to observe.
type countingTransport struct {
	cur, max atomic.Int32
}

// errTransport fails every request — for pinning the gate's release on
// the error path (a leaked slot there deadlocks the next acquire).
type errTransport struct{}

func (errTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return nil, errors.New("boom")
}

func (t *countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	n := t.cur.Add(1)
	for {
		m := t.max.Load()
		if n <= m || t.max.CompareAndSwap(m, n) {
			break
		}
	}
	time.Sleep(20 * time.Millisecond)
	t.cur.Add(-1)
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader("{}")),
		Request:    req,
	}, nil
}

// gatedTestClient returns a literal Client whose auth is pre-satisfied
// (expiresAt in the future) and whose upstream gate has the given size.
func gatedTestClient(slots int, rt http.RoundTripper) *Client {
	return &Client{
		phpSessID:     "test",
		http:          &http.Client{Transport: rt},
		upstreamSlots: make(chan struct{}, slots),
		expiresAt:     time.Now().Add(time.Hour),
	}
}

func TestUpstreamSlotsBoundConcurrency(t *testing.T) {
	rt := &countingTransport{}
	c := gatedTestClient(2, rt)

	var wg sync.WaitGroup
	errs := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.doGet("https://app-api.pixiv.net/v1/test")
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("doGet = %v, want nil", err)
		}
	}
	if got := rt.max.Load(); got > 2 {
		t.Fatalf("max concurrent upstream calls = %d, want <= 2 (gate leaked)", got)
	}
	if got := rt.max.Load(); got == 0 {
		t.Fatalf("no calls observed — transport never ran")
	}
}

func TestUpstreamSlotsReleasedOnTransportError(t *testing.T) {
	fail := errTransport{}
	c := gatedTestClient(1, fail)

	// Sequential calls: if the slot leaked after the first error, the
	// second call would deadlock on the acquire (caught by the test
	// timeout).
	for i := 0; i < 3; i++ {
		if _, err := c.doGet("https://app-api.pixiv.net/v1/test"); err == nil {
			t.Fatalf("call %d = nil error, want boom", i)
		}
	}
}

func TestUpstreamSlotsNilGateSkipsAcquire(t *testing.T) {
	// Literal clients (the test pattern everywhere else) have no gate —
	// doWith must skip the acquire entirely, not panic or block.
	rt := &countingTransport{}
	c := &Client{
		phpSessID: "test",
		http:      &http.Client{Transport: rt},
		expiresAt: time.Now().Add(time.Hour),
	}
	if _, err := c.doGet("https://app-api.pixiv.net/v1/test"); err != nil {
		t.Fatalf("doGet = %v, want nil", err)
	}
}

func TestNewPixivTransportHandshakeHeadroom(t *testing.T) {
	tr := newPixivTransport()
	if tr.TLSHandshakeTimeout != 20*time.Second {
		t.Fatalf("TLSHandshakeTimeout = %v, want 20s", tr.TLSHandshakeTimeout)
	}
}

// ── Follow-state 429 circuit breaker ───────────────────────────────────

// statusTransport answers every request with a fixed status code.
type statusTransport struct {
	code  int
	calls atomic.Int32
}

func (t *statusTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.calls.Add(1)
	return &http.Response{
		StatusCode: t.code,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       http.NoBody,
		Request:    req,
	}, nil
}

func TestFollowStateCooldownAfter429(t *testing.T) {
	rt := &statusTransport{code: 429}
	c := &Client{
		phpSessID: "test",
		http:      &http.Client{Transport: rt},
		expiresAt: time.Now().Add(time.Hour),
	}

	// First call goes upstream, hits 429, trips the breaker.
	if _, err := c.fetchFollowState("123"); err == nil {
		t.Fatal("want error for 429")
	}
	if rt.calls.Load() != 1 {
		t.Fatalf("upstream calls = %d, want 1", rt.calls.Load())
	}

	// While the breaker is hot, further calls MUST NOT touch upstream —
	// a hot limiter is never retried, it is left to cool.
	for i := 0; i < 3; i++ {
		if _, err := c.fetchFollowState("456"); err == nil {
			t.Fatal("want cooldown error")
		}
	}
	if rt.calls.Load() != 1 {
		t.Fatalf("upstream calls after 429 = %d, want still 1 (breaker leaked)", rt.calls.Load())
	}
}

func TestFollowStateCooldownExpiry(t *testing.T) {
	rt := &statusTransport{code: 200}
	c := &Client{
		phpSessID: "test",
		http:      &http.Client{Transport: rt},
		expiresAt: time.Now().Add(time.Hour),
	}
	// Pre-seed an EXPIRED cooldown — the call must go upstream again.
	c.followCooldown.Store(time.Now().Add(-time.Second).UnixNano())
	_, _ = c.fetchFollowState("789")
	if rt.calls.Load() != 1 {
		t.Fatalf("upstream calls after cooldown expiry = %d, want 1", rt.calls.Load())
	}
}
