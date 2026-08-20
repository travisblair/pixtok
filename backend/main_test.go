package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/travisblair/pixtok/pixiv"
)

// percentEncode mimics PHP urlencode for a URL string (only chars outside
// the unreserved set get %XX; unreserved chars stay literal). Test-only:
// it emulates the login SPA's encoded return_to values in fixture bodies.
func percentEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// fakeAPI is a scriptable pixivAPI for handler tests.
type fakeAPI struct {
	recommendedFn      func() ([]byte, error)
	rankingFn          func(mode string) ([]byte, error)
	newestFn           func(r18 bool, lastID string) ([]byte, error)
	topFn              func(mode string) ([]byte, error)
	streetFn           func(nextParams string) ([]byte, error)
	relatedFn          func(id string) ([]byte, error)
	workRecsFn         func(id string) ([]byte, error)
	userIllustsFn      func(id string) ([]byte, error)
	ugoiraMetaFn       func(id string) ([]byte, error)
	bookmarkAddFn      func(id string, private bool) error
	bookmarkDelFn      func(id string) error
	bookmarkIDsFn      func(restrict string, maxPages int) ([]string, error)
	bookmarkIllustsFn  func(restrict string) ([]byte, error)
	bookmarkPageFn     func(tag string, offset, limit int, order string) ([]byte, error)
	bookmarkTagsFn     func() ([]byte, error)
	setFollowFn        func(userID, restrict string, follow bool) error
	isFollowedFn       func(userID string) (bool, error)
	searchArtFn        func(word string, opts pixiv.SearchOpts, page int) ([]byte, error)
	searchUsrFn        func(nick, sMode string, page int) ([]byte, error)
	proxyNextFn        func(url string) ([]byte, error)
	proxyImageStreamFn func(url string, w http.ResponseWriter) ([]byte, string, error)
	// login-capture fns
	pkceExchangeFn  func(code, verifier string) (string, string, int, error)
	setTokensFn     func(refresh, access string, expiresIn int) error
	setWebSessionFn func(phpsessid, csrfToken string) error
	scrapeCsrfFn    func(phpsessid string) (string, error)
}

func (f *fakeAPI) GetRecommended() ([]byte, error) {
	if f.recommendedFn != nil {
		return f.recommendedFn()
	}
	return []byte(`{"illusts":[],"next_url":null}`), nil
}
func (f *fakeAPI) GetRankingIllust(mode string) ([]byte, error) {
	if f.rankingFn != nil {
		return f.rankingFn(mode)
	}
	return []byte(`{"illusts":[],"next_url":null}`), nil
}

func (f *fakeAPI) ExchangePkce(code, verifier string) (string, string, int, error) {
	if f.pkceExchangeFn != nil {
		return f.pkceExchangeFn(code, verifier)
	}
	return "refresh-1", "access-1", 3600, nil
}

func (f *fakeAPI) SetTokens(refresh, access string, expiresIn int) error {
	if f.setTokensFn != nil {
		return f.setTokensFn(refresh, access, expiresIn)
	}
	return nil
}

func (f *fakeAPI) SetWebSession(phpsessid, csrfToken string) error {
	if f.setWebSessionFn != nil {
		return f.setWebSessionFn(phpsessid, csrfToken)
	}
	return nil
}

func (f *fakeAPI) ScrapeCsrfFor(phpsessid string) (string, error) {
	if f.scrapeCsrfFn != nil {
		return f.scrapeCsrfFn(phpsessid)
	}
	return "cafebabecafebabecafebabecafebabe", nil
}

func (f *fakeAPI) AuthHealth() (bool, bool) {
	return true, true
}

func (f *fakeAPI) GetNewestIllust(r18 bool, lastID string) ([]byte, error) {
	if f.newestFn != nil {
		return f.newestFn(r18, lastID)
	}
	return []byte(`{"error":false,"body":{"illusts":[],"lastId":""}}`), nil
}

func (f *fakeAPI) GetTopIllust(mode string) ([]byte, error) {
	if f.topFn != nil {
		return f.topFn(mode)
	}
	return []byte(`{"error":false,"body":{"thumbnails":{"illust":[]}}}`), nil
}
func (f *fakeAPI) GetStreet(nextParams string) ([]byte, error) {
	if f.streetFn != nil {
		return f.streetFn(nextParams)
	}
	return []byte(`{"error":false,"body":{"contents":[]}}`), nil
}
func (f *fakeAPI) GetRelated(id string) ([]byte, error) {
	if f.relatedFn != nil {
		return f.relatedFn(id)
	}
	return []byte(`{"illusts":[],"next_url":null}`), nil
}
func (f *fakeAPI) GetWorkRecommend(id string) ([]byte, error) {
	if f.workRecsFn != nil {
		return f.workRecsFn(id)
	}
	return []byte(`{"error":false,"body":{"illusts":[]}}`), nil
}
func (f *fakeAPI) GetUserIllusts(id string) ([]byte, error) {
	if f.userIllustsFn != nil {
		return f.userIllustsFn(id)
	}
	return []byte(`{"illusts":[],"next_url":null}`), nil
}
func (f *fakeAPI) GetUgoiraMeta(id string) ([]byte, error) {
	if f.ugoiraMetaFn != nil {
		return f.ugoiraMetaFn(id)
	}
	return []byte(`{"error":false,"body":{"frames":[]}}`), nil
}
func (f *fakeAPI) BookmarkAdd(id string, private bool) error {
	if f.bookmarkAddFn != nil {
		return f.bookmarkAddFn(id, private)
	}
	return nil
}
func (f *fakeAPI) BookmarkDelete(id string) error {
	if f.bookmarkDelFn != nil {
		return f.bookmarkDelFn(id)
	}
	return nil
}

func (f *fakeAPI) GetBookmarkIDs(restrict string, maxPages int) ([]string, error) {
	if f.bookmarkIDsFn != nil {
		return f.bookmarkIDsFn(restrict, maxPages)
	}
	return nil, nil
}

func (f *fakeAPI) GetBookmarkIllusts(restrict string) ([]byte, error) {
	if f.bookmarkIllustsFn != nil {
		return f.bookmarkIllustsFn(restrict)
	}
	return []byte(`{"illusts":[],"next_url":null}`), nil
}

func (f *fakeAPI) SearchArtworks(word string, opts pixiv.SearchOpts, page int) ([]byte, error) {
	if f.searchArtFn != nil {
		return f.searchArtFn(word, opts, page)
	}
	return []byte(`{"error":false,"body":{"illustManga":{"data":[],"total":0,"lastPage":0},"popular":{"recent":[],"permanent":[]},"relatedTags":[],"tagTranslation":{}}}`), nil
}

func (f *fakeAPI) SearchUsers(nick, sMode string, page int) ([]byte, error) {
	if f.searchUsrFn != nil {
		return f.searchUsrFn(nick, sMode, page)
	}
	return []byte(`{"error":false,"body":{"users":[],"thumbnails":{"illust":[]},"page":{"workIds":{},"total":0}}}`), nil
}
func (f *fakeAPI) ProxyNext(url string) ([]byte, error) {
	if f.proxyNextFn != nil {
		return f.proxyNextFn(url)
	}
	return []byte(`{"illusts":[],"next_url":null}`), nil
}
func (f *fakeAPI) ProxyImageStream(url string, w http.ResponseWriter) ([]byte, string, error) {
	if f.proxyImageStreamFn != nil {
		return f.proxyImageStreamFn(url, w)
	}
	return []byte("fakeimg"), "image/jpeg", nil
}

func doReq(t *testing.T, h http.Handler, method, path, key string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if key != "" {
		req.Header.Set("X-Api-Key", key)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestLikeUnlikeMethodEnforcement(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	for _, path := range []string{"/api/illust/123/like", "/api/illust/123/unlike"} {
		if rr := doReq(t, h, http.MethodGet, path, "secret"); rr.Code != http.StatusMethodNotAllowed {
			t.Errorf("GET %s = %d, want 405", path, rr.Code)
		}
		if rr := doReq(t, h, http.MethodPost, path, "secret"); rr.Code != http.StatusOK {
			t.Errorf("POST %s = %d, want 200", path, rr.Code)
		}
	}
}

func TestLikeUnlikeInvalidID(t *testing.T) {
	// Non-numeric ids are rejected at the HANDLER now (400), before the
	// client is ever called — client input errors must not surface as
	// upstream 502s. The fake's error path covers upstream failures.
	f := &fakeAPI{
		bookmarkAddFn: func(id string, private bool) error {
			return errors.New("upstream exploded")
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	if rr := doReq(t, h, http.MethodPost, "/api/illust/abc/like", "secret"); rr.Code != http.StatusBadRequest {
		t.Errorf("POST /api/illust/abc/like = %d, want 400 (handler-level id guard)", rr.Code)
	}
	// A numeric id reaching an upstream failure still maps to 502.
	if rr := doReq(t, h, http.MethodPost, "/api/illust/123/like", "secret"); rr.Code != http.StatusBadGateway {
		t.Errorf("POST /api/illust/123/like = %d, want 502 (upstream failure)", rr.Code)
	}
}

func TestDoubleSlashPathCanonicalized(t *testing.T) {
	// ServeMux canonicalizes // before our handler sees it — document the
	// redirect so nobody "fixes" it into a broken expectation later.
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	if rr := doReq(t, h, http.MethodPost, "/api/illust//like", "secret"); rr.Code != http.StatusTemporaryRedirect {
		t.Errorf("POST /api/illust//like = %d, want 307 (mux canonicalization)", rr.Code)
	}
}

func TestUnknownIllustSubroute(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	if rr := doReq(t, h, http.MethodGet, "/api/illust/123", "secret"); rr.Code != http.StatusNotFound {
		t.Errorf("GET /api/illust/123 = %d, want 404", rr.Code)
	}
	if rr := doReq(t, h, http.MethodGet, "/api/illust/123/other", "secret"); rr.Code != http.StatusNotFound {
		t.Errorf("GET /api/illust/123/other = %d, want 404", rr.Code)
	}
}

func TestAPIKeyGate(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "sekrit")

	if rr := doReq(t, h, http.MethodGet, "/api/recommended", "secret"); rr.Code != http.StatusUnauthorized {
		t.Errorf("no key = %d, want 401", rr.Code)
	}
	if rr := doReq(t, h, http.MethodGet, "/api/recommended", "wrong"); rr.Code != http.StatusUnauthorized {
		t.Errorf("wrong key = %d, want 401", rr.Code)
	}
	if rr := doReq(t, h, http.MethodGet, "/api/recommended", "sekrit"); rr.Code != http.StatusOK {
		t.Errorf("right key = %d, want 200", rr.Code)
	}
	// /health bypasses the gate
	if rr := doReq(t, h, http.MethodGet, "/health", "secret"); rr.Code != http.StatusOK {
		t.Errorf("/health no key = %d, want 200", rr.Code)
	}
}

func TestAPIKeyGateFailsClosedWhenEmpty(t *testing.T) {
	// Reviewer finding: an empty key used to disable the gate entirely
	// (fail-open). Now it 401s everything except /health — a deployment
	// mistake must be loud, not open.
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "")
	if rr := doReq(t, h, http.MethodGet, "/api/recommended", ""); rr.Code != http.StatusUnauthorized {
		t.Errorf("empty key should fail closed = %d, want 401", rr.Code)
	}
	if rr := doReq(t, h, http.MethodGet, "/health", ""); rr.Code != http.StatusOK {
		t.Errorf("/health with empty key = %d, want 200", rr.Code)
	}
}

func TestUpstreamErrorsMapTo502(t *testing.T) {
	f := &fakeAPI{
		recommendedFn: func() ([]byte, error) { return nil, errors.New("upstream down") },
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	if rr := doReq(t, h, http.MethodGet, "/api/recommended", "secret"); rr.Code != http.StatusBadGateway {
		t.Errorf("upstream error = %d, want 502", rr.Code)
	}
}

func TestImgProxyCache(t *testing.T) {
	calls := 0
	f := &fakeAPI{
		proxyImageStreamFn: func(url string, w http.ResponseWriter) ([]byte, string, error) {
			calls++
			return []byte("imgbytes"), "image/jpeg", nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	rr1 := doReq(t, h, http.MethodGet, "/api/img?url=https://i.pximg.net/1.jpg", "secret")
	if rr1.Code != http.StatusOK || rr1.Header().Get("X-Cache") != "MISS" {
		t.Fatalf("first = %d X-Cache=%s, want 200 MISS", rr1.Code, rr1.Header().Get("X-Cache"))
	}
	rr2 := doReq(t, h, http.MethodGet, "/api/img?url=https://i.pximg.net/1.jpg", "secret")
	if rr2.Code != http.StatusOK || rr2.Header().Get("X-Cache") != "HIT" {
		t.Fatalf("second = %d X-Cache=%s, want 200 HIT", rr2.Code, rr2.Header().Get("X-Cache"))
	}
	if calls != 1 {
		t.Errorf("upstream called %d times, want 1", calls)
	}
}

// The image semaphore bounds CONCURRENT fetches: the 5th simultaneous
// miss must 429, not queue up another outbound request + buffer.
func TestImgProxySaturation429(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, maxConcurrentImageFetches+1)
	f := &fakeAPI{
		proxyImageStreamFn: func(url string, w http.ResponseWriter) ([]byte, string, error) {
			entered <- struct{}{}
			<-release
			return []byte("img"), "image/jpeg", nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	done := make(chan *httptest.ResponseRecorder, maxConcurrentImageFetches)
	for i := 0; i < maxConcurrentImageFetches; i++ {
		go func(n int) {
			req := httptest.NewRequest(http.MethodGet,
				fmt.Sprintf("/api/img?url=https://i.pximg.net/%d.jpg", n), nil)
			req.Header.Set("X-Api-Key", "secret")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			done <- rec
		}(i)
	}
	// Wait until all four fetches are in flight.
	for i := 0; i < maxConcurrentImageFetches; i++ {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("fetches did not all enter within 5s")
		}
	}

	rr := doReq(t, h, http.MethodGet, "/api/img?url=https://i.pximg.net/extra.jpg", "secret")
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("5th concurrent miss = %d, want 429", rr.Code)
	}
	if rr.Header().Get("Retry-After") == "" {
		t.Error("429 without Retry-After")
	}

	close(release)
	for i := 0; i < maxConcurrentImageFetches; i++ {
		<-done
	}
}

func TestImgProxyMissingURL(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	if rr := doReq(t, h, http.MethodGet, "/api/img", "secret"); rr.Code != http.StatusBadRequest {
		t.Errorf("missing url = %d, want 400", rr.Code)
	}
	if rr := doReq(t, h, http.MethodGet, "/api/next", "secret"); rr.Code != http.StatusBadRequest {
		t.Errorf("missing next url = %d, want 400", rr.Code)
	}
}

func TestImageCacheBasics(t *testing.T) {
	c := newImageCache(time.Hour, 10, 512<<20)
	c.set("k", []byte("v"), "image/jpeg")
	if data, ct, ok := c.get("k"); !ok || string(data) != "v" || ct != "image/jpeg" {
		t.Errorf("get after set failed: %q %q %v", data, ct, ok)
	}
	if _, _, ok := c.get("missing"); ok {
		t.Error("get missing key should miss")
	}
}

func TestImageCacheExpiry(t *testing.T) {
	c := newImageCache(-time.Second, 10, 512<<20) // already expired on read
	c.set("k", []byte("v"), "image/jpeg")
	if _, _, ok := c.get("k"); ok {
		t.Error("expired entry should miss")
	}
}

func TestImageCacheEntryCapEviction(t *testing.T) {
	c := newImageCache(time.Hour, 2, 512<<20)
	c.set("a", []byte("1"), "image/jpeg")
	c.set("b", []byte("2"), "image/jpeg")
	c.set("c", []byte("3"), "image/jpeg")
	if len(c.items) > 2 {
		t.Errorf("cache has %d entries, want <= 2", len(c.items))
	}
	if _, _, ok := c.get("c"); !ok {
		t.Error("newest entry should survive eviction")
	}
}

func TestImageCacheByteBudget(t *testing.T) {
	c := newImageCache(time.Hour, 100, 200)
	// 200-byte budget: three 100-byte entries -> third forces eviction
	c.mu.Lock()
	c.totalBytes = 0
	c.mu.Unlock()

	big := func() []byte { return make([]byte, 100) }
	c.set("a", big(), "image/jpeg")
	c.set("b", big(), "image/jpeg")
	c.set("c", big(), "image/jpeg")

	c.mu.RLock()
	total := c.totalBytes
	n := len(c.items)
	c.mu.RUnlock()
	if total > 200 {
		t.Errorf("totalBytes = %d, want <= 200", total)
	}
	if n > 2 {
		t.Errorf("entries = %d, want <= 2", n)
	}
}

func TestImageCacheOversizedSkipped(t *testing.T) {
	c := newImageCache(time.Hour, 10, 512<<20)
	c.set("huge", make([]byte, maxEntryBytes+1), "image/jpeg")
	if _, _, ok := c.get("huge"); ok {
		t.Error("oversized entry should not be cached")
	}
}

func TestImageCacheOverwriteAccounting(t *testing.T) {
	c := newImageCache(time.Hour, 10, 512<<20)
	c.set("k", make([]byte, 100), "image/jpeg")
	c.mu.RLock()
	first := c.totalBytes
	c.mu.RUnlock()
	c.set("k", make([]byte, 300), "image/jpeg")
	c.mu.RLock()
	second := c.totalBytes
	c.mu.RUnlock()
	if first != 100 || second != 300 {
		t.Errorf("overwrite accounting wrong: %d -> %d, want 100 -> 300", first, second)
	}
}

func TestImageCacheReapOnce(t *testing.T) {
	c := newImageCache(time.Hour, 10, 512<<20)
	c.set("k", make([]byte, 50), "image/jpeg")
	c.reapOnce(time.Now().Add(2 * time.Hour))
	c.mu.RLock()
	n := len(c.items)
	total := c.totalBytes
	c.mu.RUnlock()
	if n != 0 || total != 0 {
		t.Errorf("reap left %d entries / %d bytes", n, total)
	}
}

func TestTransformStreet(t *testing.T) {
	raw := `{"error":false,"body":{"contents":[
		{"kind":"illust","thumbnails":[{"type":"illust","pageCount":1,"id":"111","title":"T1",
		 "userId":"9","userName":"Alice","profileImageUrl":"https://i.pximg.net/p1",
		 "xRestrict":1,"aiType":2,
		 "tags":[{"name":"\u30bf\u30b0","translatedName":"tag","isEmphasized":true}],
		 "pages":[{"width":1000,"height":1400,"urls":{"1200x1200_standard":"https://i.pximg.net/l1","540x540":"https://i.pximg.net/m1","360x360":"https://i.pximg.n...s1"}}]}]},
		{"kind":"separator","id":"x"},
		{"kind":"manga","thumbnails":[{"type":"manga","pageCount":2,"id":"222","title":"M1",
		 "userId":"8","userName":"Bob","profileImageUrl":"https://i.pximg.net/p2",
		 "pages":[
			{"urls":{"1200x1200_standard":"https://i.pximg.net/l2a","540x540":"https://i.pximg.net/m2a","360x360":"https://i.pximg.net/s2a"}},
			{"urls":{"1200x1200_standard":"https://i.pximg.net/l2b","540x540":"https://i.pximg.net/m2b","360x360":"https://i.pximg.n...s2b"}}]}]},
		{"kind":"novel","thumbnails":[{"type":"novel","id":"333"}]}
	],
	"nextParams":{"page":2,"li":"111"}}}`

	out, err := transformStreet([]byte(raw))
	if err != nil {
		t.Fatalf("transformStreet: %v", err)
	}
	var resp struct {
		Illusts []struct {
			ID        string `json:"id"`
			XRestrict int    `json:"x_restrict"`
			AIType    int    `json:"ai_type"`
			MetaPages []struct {
				ImageURLs struct {
					Large string `json:"large"`
				} `json:"image_urls"`
			} `json:"meta_pages"`
			Tags []struct {
				Name string `json:"name"`
			} `json:"tags"`
			ImageURLs map[string]string `json:"image_urls"`
		} `json:"illusts"`
		NextURL *string `json:"next_url"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(resp.Illusts) != 2 {
		t.Fatalf("got %d illusts, want 2 (separator and novel dropped)", len(resp.Illusts))
	}
	first := resp.Illusts[0]
	if first.ID != "111" || first.XRestrict != 1 || first.AIType != 2 {
		t.Errorf("first illust metadata wrong: %+v", first)
	}
	if len(first.Tags) != 1 || first.Tags[0].Name != "タグ" {
		t.Errorf("tags wrong: %+v", first.Tags)
	}
	if first.ImageURLs["large"] != "https://i.pximg.net/l1" {
		t.Errorf("top-level image_urls large wrong: %+v", first.ImageURLs)
	}
	second := resp.Illusts[1]
	if second.ID != "222" || len(second.MetaPages) != 2 {
		t.Errorf("manga mapping wrong: %+v", second)
	}
	if resp.NextURL == nil || *resp.NextURL == "" {
		t.Error("next_url should carry the nextParams cursor")
	}
}

// Regression: web AJAX works carry illustType (0=illust, 1=manga,
// 2=ugoira) and usually NO type string. The old mapping dropped
// illustType 2 into "illust", so live ugoira works never mounted the
// FE ▶ player — a live type=ugoira search returned 60 real ugoira
// works, every one typed "illust".
func TestTransformUgoiraTypeSurvives(t *testing.T) {
	t.Run("newest via mapWebIllusts", func(t *testing.T) {
		raw := `{"error":false,"message":"","body":{"illusts":[
			{"id":"111","title":"U1","illustType":2,"pageCount":1,"url":"https://i.pximg.net/c/360x360_70/img-master/img/2026/01/01/00/00/00/111_p0_square1200.jpg","userId":"9","userName":"Alice","profileImageUrl":"https://i.pximg.net/p1"},
			{"id":"222","title":"M1","illustType":1,"pageCount":2,"url":"https://i.pximg.net/c/360x360_70/img-master/img/2026/01/01/00/00/00/222_p0_square1200.jpg","userId":"8","userName":"Bob","profileImageUrl":"https://i.pximg.net/p2"},
			{"id":"333","title":"I1","illustType":0,"pageCount":1,"url":"https://i.pximg.net/c/360x360_70/img-master/img/2026/01/01/00/00/00/333_p0_square1200.jpg","userId":"7","userName":"Cid","profileImageUrl":"https://i.pximg.net/p3"}
		],"lastId":"111"}}`
		out, err := transformNewest([]byte(raw), false)
		if err != nil {
			t.Fatalf("transformNewest: %v", err)
		}
		var resp struct {
			Illusts []struct {
				ID   string `json:"id"`
				Type string `json:"type"`
			} `json:"illusts"`
		}
		if err := json.Unmarshal(out, &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		want := map[string]string{"111": "ugoira", "222": "manga", "333": "illust"}
		for _, w := range resp.Illusts {
			if want[w.ID] != w.Type {
				t.Errorf("work %s type = %q, want %q", w.ID, w.Type, want[w.ID])
			}
		}
	})

	t.Run("top illust firehose", func(t *testing.T) {
		raw := `{"error":false,"body":{"thumbnails":{"illust":[
			{"id":"111","title":"U1","illustType":2,"pageCount":1,"userId":"9","userName":"Alice","profileImageUrl":"https://i.pximg.net/p1","urls":{"large":"https://i.pximg.net/l1"}}
		]}}}`
		out, err := transformTopIllust([]byte(raw))
		if err != nil {
			t.Fatalf("transformTopIllust: %v", err)
		}
		var resp struct {
			Illusts []struct {
				Type string `json:"type"`
			} `json:"illusts"`
		}
		if err := json.Unmarshal(out, &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(resp.Illusts) != 1 || resp.Illusts[0].Type != "ugoira" {
			t.Fatalf("firehose ugoira work mapped to %+v, want type ugoira", resp.Illusts)
		}
	})

	t.Run("street", func(t *testing.T) {
		raw := `{"error":false,"body":{"contents":[
			{"kind":"illust","thumbnails":[{"type":"illust","illustType":2,"pageCount":1,"id":"111","title":"U1","userId":"9","userName":"Alice","profileImageUrl":"https://i.pximg.net/p1","pages":[{"urls":{"1200x1200_standard":"https://i.pximg.net/l1"}}]}]}
		],"nextParams":null}}`
		out, err := transformStreet([]byte(raw))
		if err != nil {
			t.Fatalf("transformStreet: %v", err)
		}
		var resp struct {
			Illusts []struct {
				Type string `json:"type"`
			} `json:"illusts"`
		}
		if err := json.Unmarshal(out, &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(resp.Illusts) != 1 || resp.Illusts[0].Type != "ugoira" {
			t.Fatalf("street ugoira work mapped to %+v, want type ugoira", resp.Illusts)
		}
	})
}

// Regression: search + top-firehose responses carry a response-level
// tagTranslation map; the transforms must fill TranslatedName on each
// work's tags so card chips can render translations like the popup.
func TestTransformTagTranslationsApplied(t *testing.T) {
	t.Run("search artworks", func(t *testing.T) {
		raw := `{"error":false,"body":{
			"illustManga":{"data":[
				{"id":"111","title":"T1","illustType":0,"pageCount":1,"url":"https://i.pximg.net/c/360x360_70/img-master/img/x/111_p0_square1200.jpg","userId":"9","userName":"Alice","tags":["水着","オリジナル"]}
			],"total":1,"lastPage":1},
			"popular":{"recent":[{"id":"222","title":"P1","illustType":0,"pageCount":1,"url":"https://i.pximg.net/c/360x360_70/img-master/img/x/222_p0_square1200.jpg","userId":"8","userName":"Bob","tags":["水着"]}],"permanent":[]},
			"tagTranslation":{"水着":{"en":"Swimsuit"}},
			"relatedTags":[]
		}}`
		resp, err := transformSearchArtworks([]byte(raw))
		if err != nil {
			t.Fatalf("transformSearchArtworks: %v", err)
		}
		if len(resp.Illusts) != 1 || len(resp.Illusts[0].Tags) != 2 {
			t.Fatalf("illusts/tags wrong: %+v", resp.Illusts)
		}
		if got := resp.Illusts[0].Tags[0].TranslatedName; got != "Swimsuit" {
			t.Errorf("tag 水着 TranslatedName = %q, want Swimsuit", got)
		}
		if got := resp.Illusts[0].Tags[1].TranslatedName; got != "" {
			t.Errorf("unmapped tag got translation %q, want empty", got)
		}
		if len(resp.Popular) != 1 || resp.Popular[0].Tags[0].TranslatedName != "Swimsuit" {
			t.Errorf("popular block translation missing: %+v", resp.Popular)
		}
	})

	t.Run("top firehose", func(t *testing.T) {
		raw := `{"error":false,"body":{"thumbnails":{"illust":[
			{"id":"111","title":"T1","illustType":0,"pageCount":1,"userId":"9","userName":"Alice","profileImageUrl":"https://i.pximg.net/p1","tags":["水着"],"urls":{"large":"https://i.pximg.net/l1"}}
		]},"tagTranslation":{"水着":{"en":"Swimsuit"}}}}`
		out, err := transformTopIllust([]byte(raw))
		if err != nil {
			t.Fatalf("transformTopIllust: %v", err)
		}
		var resp struct {
			Illusts []struct {
				Tags []struct {
					TranslatedName string `json:"translated_name"`
				} `json:"tags"`
			} `json:"illusts"`
		}
		if err := json.Unmarshal(out, &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(resp.Illusts) != 1 || resp.Illusts[0].Tags[0].TranslatedName != "Swimsuit" {
			t.Errorf("firehose translation missing: %+v", resp.Illusts)
		}
	})
}

func TestTransformStreetNoNext(t *testing.T) {
	raw := `{"error":false,"body":{"contents":[],"nextParams":null}}`
	out, err := transformStreet([]byte(raw))
	if err != nil {
		t.Fatalf("transformStreet: %v", err)
	}
	var resp struct {
		NextURL *string `json:"next_url"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.NextURL != nil {
		t.Errorf("next_url should be null, got %v", *resp.NextURL)
	}
}

func TestTransformWorkRecommend(t *testing.T) {
	raw := `{"error":false,"message":"","body":{"illusts":[
		{"id":"111","title":"One","type":"illust","userId":"9","userName":"Alice",
		 "profileImageUrl":"https://i.pximg.net/user-profile/50.png",
		 "url":"https://i.pximg.net/c/360x360_70/img-master/img/2026/07/23/23/41/47/111_p0_square1200.jpg",
		 "pageCount":1,"createDate":"2026-07-23T23:41:47+09:00","description":"cap",
		 "tags":["葬送のフリーレン"],"xRestrict":1,"aiType":2,"bookmarkData":null},
		{"id":"222","title":"Two","type":"manga","userId":"9","userName":"Alice",
		 "profileImageUrl":"https://i.pximg.net/user-profile/50.png",
		 "url":"https://i.pximg.net/c/360x360_70/img-master/img/2026/07/24/00/00/00/222_p0_square1200.jpg",
		 "pageCount":2,"tags":[],"bookmarkData":{"id":"bk1"}}
	],"nextIds":[],"details":{}}}`

	out, err := transformWorkRecommend([]byte(raw))
	if err != nil {
		t.Fatalf("transformWorkRecommend: %v", err)
	}
	var resp struct {
		Illusts []struct {
			ID         string `json:"id"`
			Type       string `json:"type"`
			XRestrict  int    `json:"x_restrict"`
			AIType     int    `json:"ai_type"`
			PageCount  int    `json:"page_count"`
			Bookmarked bool   `json:"is_bookmarked"`
			Tags       []struct {
				Name string `json:"name"`
			} `json:"tags"`
			ImageURLs struct {
				Large string `json:"large"`
			} `json:"image_urls"`
			MetaPages []struct {
				ImageURLs struct {
					Large string `json:"large"`
				} `json:"image_urls"`
			} `json:"meta_pages"`
		} `json:"illusts"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Illusts) != 2 {
		t.Fatalf("got %d illusts, want 2", len(resp.Illusts))
	}

	a := resp.Illusts[0]
	if a.Type != "illust" || a.XRestrict != 1 || a.AIType != 2 || a.Bookmarked {
		t.Errorf("work one mapped wrong: %+v", a)
	}
	if len(a.Tags) != 1 || a.Tags[0].Name != "葬送のフリーレン" {
		t.Errorf("tags mapped wrong: %+v", a.Tags)
	}
	wantLarge := "https://i.pximg.net/img-master/img/2026/07/23/23/41/47/111_p0_master1200.jpg"
	if a.ImageURLs.Large != wantLarge {
		t.Errorf("large URL = %q, want %q", a.ImageURLs.Large, wantLarge)
	}
	if a.MetaPages != nil {
		t.Errorf("single-page work should have nil meta_pages")
	}

	b := resp.Illusts[1]
	if b.Type != "manga" || !b.Bookmarked || b.PageCount != 2 {
		t.Errorf("work two mapped wrong: %+v", b)
	}
	if len(b.MetaPages) != 2 {
		t.Fatalf("manga should have 2 meta pages, got %d", len(b.MetaPages))
	}
	if b.MetaPages[1].ImageURLs.Large != "https://i.pximg.net/img-master/img/2026/07/24/00/00/00/222_p1_master1200.jpg" {
		t.Errorf("page 2 URL = %q", b.MetaPages[1].ImageURLs.Large)
	}
}

func TestTransformWorkRecommendInvalidJSON(t *testing.T) {
	if _, err := transformWorkRecommend([]byte(`{`)); err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestDeriveLargeFallback(t *testing.T) {
	odd := "https://example.com/not-a-pixiv-thumb.jpg"
	got, ok := deriveLarge(odd)
	if ok {
		t.Errorf("deriveLarge should report no-match for unknown patterns")
	}
	if got != odd {
		t.Errorf("deriveLarge should pass through unknown patterns, got %q", got)
	}
	if _, ok := deriveLarge("https://i.pximg.net/c/360x360_70/img-master/img/x/1_p0_square1200.jpg"); !ok {
		t.Error("deriveLarge should match the known thumbnail pattern")
	}
	// Regression: search / illust/new thumbs use the c/250x250_80_a2
	// prefix — the old 360x360_70-only match passed the 250px square
	// through as `large`, so ugoira posters rendered as giant square
	// blocks that snapped to the real ratio when the animation started.
	a2, ok := deriveLarge("https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/08/15/20/07/54/148463904_square1200.jpg")
	if !ok {
		t.Fatal("deriveLarge should match the _a2 thumbnail prefix")
	}
	if want := "https://i.pximg.net/img-master/img/2026/08/15/20/07/54/148463904_master1200.jpg"; a2 != want {
		t.Errorf("_a2 derive = %q, want %q", a2, want)
	}
	// Regression: pixiv's custom-thumb scheme (newer AI/custom-cropped
	// works, Aug 2026) — the c/ resize prefix must be dropped and the
	// custom1200 variant kept (it IS the 1200px full size). The old
	// regex only knew img-master, so these works rendered as stretched
	// 250px squares — the occasional fuzzy cards.
	ct, ok := deriveLarge("https://i.pximg.net/c/250x250_80_a2/custom-thumb/img/2026/08/16/08/07/26/148485956_p0_custom1200.jpg")
	if !ok {
		t.Fatal("deriveLarge should match the custom-thumb path")
	}
	if want := "https://i.pximg.net/custom-thumb/img/2026/08/16/08/07/26/148485956_p0_custom1200.jpg"; ct != want {
		t.Errorf("custom-thumb derive = %q, want %q", ct, want)
	}
}

func TestPageThumb(t *testing.T) {
	thumb := "https://i.pximg.net/c/360x360_70/img-master/img/2026/07/23/23/41/47/111_p0_square1200.jpg"
	if got := pageThumb(thumb, 0); got != thumb {
		t.Errorf("pageThumb(0) should be identity, got %q", got)
	}
	want := "https://i.pximg.net/c/360x360_70/img-master/img/2026/07/23/23/41/47/111_p2_square1200.jpg"
	if got := pageThumb(thumb, 2); got != want {
		t.Errorf("pageThumb(2) = %q, want %q", got, want)
	}
}

func TestWorkRecsHandler(t *testing.T) {
	var gotID string
	f := &fakeAPI{
		workRecsFn: func(id string) ([]byte, error) {
			gotID = id
			return []byte(`{"error":false,"body":{"illusts":[
				{"id":"777","title":"Rec","type":"illust","userId":"1","userName":"B",
				 "url":"https://i.pximg.net/c/360x360_70/img-master/img/2026/07/23/23/41/47/777_p0_square1200.jpg",
				 "pageCount":1}]}}`), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	req := httptest.NewRequest(http.MethodGet, "/api/illust/123/recs", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/illust/123/recs = %d, want 200: %s", rr.Code, rr.Body.String())
	}
	if gotID != "123" {
		t.Errorf("gotID = %q, want 123", gotID)
	}
	var resp struct {
		Illusts []struct {
			ID string `json:"id"`
		} `json:"illusts"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(resp.Illusts) != 1 || resp.Illusts[0].ID != "777" {
		t.Errorf("bad response body: %+v", resp)
	}
}

func TestWorkRecsHandlerMethodAndID(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	if rr := doReq(t, h, http.MethodPost, "/api/illust/123/recs", "secret"); rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /recs = %d, want 405", rr.Code)
	}
	if rr := doReq(t, h, http.MethodGet, "/api/illust/abc/recs", "secret"); rr.Code != http.StatusBadRequest {
		t.Errorf("GET /recs non-numeric id = %d, want 400", rr.Code)
	}
	if rr := doReq(t, h, http.MethodGet, "/api/illust/12/related", "secret"); rr.Code == http.StatusBadRequest {
		t.Errorf("GET /related valid id should not 400")
	}
	if rr := doReq(t, h, http.MethodGet, "/api/illust/x/related", "secret"); rr.Code != http.StatusBadRequest {
		t.Errorf("GET /related non-numeric id = %d, want 400", rr.Code)
	}
}

func TestWorkRecsHandlerNotFound(t *testing.T) {
	f := &fakeAPI{
		workRecsFn: func(id string) ([]byte, error) {
			return nil, fmt.Errorf("%w (HTTP 404)", pixiv.ErrNotFound)
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	req := httptest.NewRequest(http.MethodGet, "/api/illust/999/recs", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404", rr.Code)
	}
}

func TestWorkRecsHandlerUpstreamError(t *testing.T) {
	f := &fakeAPI{
		workRecsFn: func(id string) ([]byte, error) {
			return nil, errors.New("pixiv says no")
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	req := httptest.NewRequest(http.MethodGet, "/api/illust/1/recs", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadGateway {
		t.Errorf("got %d, want 502", rr.Code)
	}
}

func TestUserIllustsHandler(t *testing.T) {
	var gotID string
	f := &fakeAPI{
		userIllustsFn: func(id string) ([]byte, error) {
			gotID = id
			return []byte(`{"illusts":[{"id":9,"title":"A"}],"next_url":null}`), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	if rr := doReq(t, h, http.MethodGet, "/api/user/abc/illusts", "secret"); rr.Code != http.StatusBadRequest {
		t.Errorf("non-numeric user id = %d, want 400", rr.Code)
	}
	if rr := doReq(t, h, http.MethodGet, "/api/user/77/illusts", "secret"); rr.Code != http.StatusOK {
		t.Errorf("GET /api/user/77/illusts = %d, want 200", rr.Code)
	}
	if gotID != "77" {
		t.Errorf("gotID = %q, want 77", gotID)
	}
	if rr := doReq(t, h, http.MethodGet, "/api/user/77/other", "secret"); rr.Code != http.StatusNotFound {
		t.Errorf("unknown subroute = %d, want 404", rr.Code)
	}
}

func TestUgoiraMetaHandler(t *testing.T) {
	var gotID string
	f := &fakeAPI{
		ugoiraMetaFn: func(id string) ([]byte, error) {
			gotID = id
			return []byte(`{"error":false,"body":{"frames":[{"file":"000000.jpg","delay":66}]}}`), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	if rr := doReq(t, h, http.MethodPost, "/api/illust/5/ugoira_meta", "secret"); rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST ugoira_meta = %d, want 405", rr.Code)
	}
	if rr := doReq(t, h, http.MethodGet, "/api/illust/5/ugoira_meta", "secret"); rr.Code != http.StatusOK {
		t.Errorf("GET ugoira_meta = %d, want 200", rr.Code)
	}
	if gotID != "5" {
		t.Errorf("gotID = %q, want 5", gotID)
	}
}

func TestStreetHandler(t *testing.T) {
	var gotParams string
	f := &fakeAPI{
		streetFn: func(nextParams string) ([]byte, error) {
			gotParams = nextParams
			return []byte(`{"error":false,"body":{"contents":[]}}`), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	// GET rejected
	if rr := doReq(t, h, http.MethodGet, "/api/street", "secret"); rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /api/street = %d, want 405", rr.Code)
	}

	// POST with cursor body passes it through
	req := httptest.NewRequest(http.MethodPost, "/api/street", strings.NewReader(`{"page":2,"li":"111"}`))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("POST /api/street = %d, want 200", rr.Code)
	}
	if gotParams != `{"page":2,"li":"111"}` {
		t.Errorf("cursor body not passed through: %q", gotParams)
	}
}
func TestRankingPassthrough(t *testing.T) {
	// The app-API ranking response passes through VERBATIM (numeric ids,
	// next_url included) — the frontend normalizes ids like every other
	// app-API feed.
	f := &fakeAPI{
		rankingFn: func(mode string) ([]byte, error) {
			if mode != "day" {
				t.Errorf("mode = %q, want day", mode)
			}
			return []byte(`{"illusts":[{"id":42,"title":"Ranked","user":{"id":7},"image_urls":{"large":"https://i.pximg.net/l.jpg"}}],"next_url":"https://app-api.pixiv.net/next"}`), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	rr := doReq(t, h, http.MethodGet, "/api/top?mode=day", "secret")
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/top?mode=day = %d, want 200", rr.Code)
	}
	body := rr.Body.String()
	if !strings.Contains(body, `"id":42`) || !strings.Contains(body, `"next_url":"https://app-api.pixiv.net/next"`) {
		t.Errorf("body not passed through verbatim: %s", body)
	}
}

func TestRankingInvalidMode(t *testing.T) {
	f := &fakeAPI{
		rankingFn: func(mode string) ([]byte, error) {
			return nil, fmt.Errorf("%w: invalid ranking mode", pixiv.ErrInvalidParam)
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	if rr := doReq(t, h, http.MethodGet, "/api/top?mode=hacked", "secret"); rr.Code != http.StatusBadRequest {
		t.Errorf("invalid mode = %d, want 400", rr.Code)
	}
}

func TestRankingUpstreamError(t *testing.T) {
	f := &fakeAPI{
		rankingFn: func(mode string) ([]byte, error) {
			return nil, errors.New("API returned 500: boom")
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	if rr := doReq(t, h, http.MethodGet, "/api/top?mode=week", "secret"); rr.Code != http.StatusBadGateway {
		t.Errorf("upstream failure = %d, want 502", rr.Code)
	}
}

func TestNewestHandler(t *testing.T) {
	f := &fakeAPI{
		newestFn: func(r18 bool, lastID string) ([]byte, error) {
			if !r18 || lastID != "12345" {
				t.Errorf("r18=%v lastID=%q, want true/12345", r18, lastID)
			}
			return []byte(`{"error":false,"body":{"illusts":[{"id":"9","title":"new","url":"https://i.pximg.net/c/360x360_70/img-master/img/9_p0_square1200.jpg","userId":"1","userName":"u","profileImageUrl":"p","pageCount":1,"tags":["cute"],"aiType":1,"type":"illust"}],"lastId":"777"}}`), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	rr := doReq(t, h, http.MethodGet, "/api/newest?r18=true&lastId=12345", "secret")
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/newest = %d, want 200", rr.Code)
	}
	body := rr.Body.String()
	if !strings.Contains(body, `"id":"9"`) {
		t.Errorf("newest work not transformed: %s", body)
	}
	// lastId cursor becomes the relative next_url (r18 preserved). Go's
	// json.Marshal escapes & as \u0026 — clients decode it back.
	if !strings.Contains(body, `/api/newest?r18=true\u0026lastId=777`) {
		t.Errorf("next_url missing/incorrect: %s", body)
	}
}

func TestNewestHandlerRejectsBadLastID(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	if rr := doReq(t, h, http.MethodGet, "/api/newest?lastId=abc", "secret"); rr.Code != http.StatusBadRequest {
		t.Errorf("bad lastId = %d, want 400", rr.Code)
	}
}

func TestTopIllustHandler(t *testing.T) {
	f := &fakeAPI{
		topFn: func(mode string) ([]byte, error) {
			if mode != "all" {
				t.Errorf("mode = %q, want all", mode)
			}
			return []byte(`{"error":false,"body":{"thumbnails":{"illust":[{"id":"5","title":"top","userId":"2","userName":"a","pageCount":1,"urls":{"1200x1200":"https://i.pximg.net/t.jpg"},"profileImageUrl":"p","createDate":"2026"}]}}}`), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	rr := doReq(t, h, http.MethodGet, "/api/topillust?mode=all", "secret")
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/topillust = %d, want 200", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), `"id":"5"`) {
		t.Errorf("top work not transformed: %s", rr.Body.String())
	}
}

func TestTopIllustHandlerRejectsBadMode(t *testing.T) {
	f := &fakeAPI{
		topFn: func(mode string) ([]byte, error) {
			return nil, fmt.Errorf("%w: invalid top mode", pixiv.ErrInvalidParam)
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	if rr := doReq(t, h, http.MethodGet, "/api/topillust?mode=nope", "secret"); rr.Code != http.StatusBadRequest {
		t.Errorf("bad mode = %d, want 400", rr.Code)
	}
}

func doReqJSON(t *testing.T, h http.Handler, method, path, key, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if key != "" {
		req.Header.Set("X-Api-Key", key)
	}
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestAuthStatus(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	rr := doReq(t, h, http.MethodGet, "/api/auth/status", "secret")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var st struct {
		AppAPI     bool `json:"app_api"`
		WebSession bool `json:"web_session"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &st); err != nil {
		t.Fatalf("parse status: %v", err)
	}
	if !st.AppAPI || !st.WebSession {
		t.Fatalf("status body: %s", rr.Body.String())
	}
}

// ── Proxied-login tests (fake pixiv upstream) ───────────────────────────

func fakePixivUpstream(t *testing.T) (*httptest.Server, map[string]string) {
	t.Helper()
	base := ""
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		t.Logf("FAKE upstream got %s %s", r.Method, r.URL.String())
		// A login page that sets a domain-scoped session cookie and, on
		// POST, redirects into the app-api callback like the real flow.
		w.Header().Add("Set-Cookie", "PHPSESSID=upstreamsession123; Path=/; Domain=.pixiv.net; Secure; HttpOnly")
		if r.Method == http.MethodPost {
			http.Redirect(w, r, base+"/web/v1/users/auth/pixiv/callback?state=THE-STATE&code=THE-CODE", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<html>login form</html>"))
	})
	mux.HandleFunc("/web/v1/login", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, base+"/login?prompt=select_account&return_to=x", http.StatusFound)
	})
	mux.HandleFunc("/web/v1/users/auth/pixiv/callback", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("callback page"))
	})
	mux.HandleFunc("/post-redirect", func(w http.ResponseWriter, r *http.Request) {
		// The bouncer page: with a valid return_to it would 302 (Location
		// rewrite covers that), but if it meta-refresh/JS-navigates the
		// proxy must rewrite the embedded URL too.
		w.Header().Set("Content-Type", "text/html; charset=UTF-8")
		w.Write([]byte(`<html><head><meta http-equiv="refresh" content="0; url=` + base + `/web/v1/users/auth/pixiv/start?code_challenge=X"></head><body>go</body></html>`))
	})
	mux.HandleFunc("/ajax/login", func(w http.ResponseWriter, r *http.Request) {
		// The real SPA replies with a post-redirect returnTo whose
		// return_to query param is a PERCENT-ENCODED app-api URL — the
		// proxy must rewrite both the outer URL and the encoded inner
		// one so the browser stays on our origin.
		w.Header().Set("Content-Type", "application/json")
		inner := base + "/web/v1/users/auth/pixiv/start?code_challenge=X"
		w.Write([]byte(`{"success":{"returnTo":"` + base + `/post-redirect?return_to=` + percentEncode(inner) + `"}}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("www page"))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	base = srv.URL // handlers read it lazily — requests only arrive after this

	targets := map[string]string{
		"accounts": srv.URL,
		"app":      srv.URL,
		"www":      srv.URL,
	}
	return srv, targets
}

func withProxyTargets(t *testing.T, targets map[string]string) {
	t.Helper()
	old := authProxyTargets
	authProxyTargets = targets
	t.Cleanup(func() { authProxyTargets = old })
}

func withFlowCookie(req *http.Request) *http.Request {
	req.AddCookie(&http.Cookie{Name: loginFlowCookie, Value: "1"})
	return req
}

func TestAuthProxyRequiresFlowCookie(t *testing.T) {
	_, targets := fakePixivUpstream(t)
	withProxyTargets(t, targets)
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	req := httptest.NewRequest(http.MethodGet, "/api/auth/px/accounts/login", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("no flow cookie = %d, want 403", rr.Code)
	}
}

func TestAuthProxyStripsPixtokCookies(t *testing.T) {
	// Our cookies (the login-flow gate and the app gate session) must
	// never leave for pixiv's hosts — only pixiv's own cookies ride the
	// proxy. Regression: the filter once dropped only pixtok_login and
	// leaked pixtok_gate (the 30-day app session token) upstream.
	var upstreamCookie atomic.Value
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCookie.Store(r.Header.Get("Cookie"))
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("<html>ok</html>"))
	}))
	t.Cleanup(up.Close)
	withProxyTargets(t, map[string]string{
		"accounts": up.URL,
		"app":      up.URL,
		"www":      up.URL,
		"oauth":    up.URL,
	})
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	req := withFlowCookie(httptest.NewRequest(http.MethodGet, "/api/auth/px/accounts/login", nil))
	req.AddCookie(&http.Cookie{Name: gateCookie, Value: "app-session-token"})
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "upstreamsession123"})
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("proxied GET = %d, want 200", rr.Code)
	}
	got, _ := upstreamCookie.Load().(string)
	if strings.Contains(got, "pixtok_") {
		t.Fatalf("pixtok cookies leaked upstream: %q", got)
	}
	if !strings.Contains(got, "PHPSESSID=upstreamsession123") {
		t.Fatalf("pixiv session cookie dropped: %q", got)
	}
}

func TestAuthProxyRewritesCookiesAndLocations(t *testing.T) {
	t.Setenv("PIXTOK_PUBLIC_HTTPS", "false") // pin: strip Secure for HTTP dev
	_, targets := fakePixivUpstream(t)
	withProxyTargets(t, targets)
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	// GET the login page: cookie must come back host-only.
	req := withFlowCookie(httptest.NewRequest(http.MethodGet, "/api/auth/px/accounts/login", nil))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "login form") {
		t.Fatalf("proxied GET = %d body=%q", rr.Code, rr.Body.String())
	}
	got := rr.Header().Values("Set-Cookie")
	joined := strings.Join(got, "|")
	if !strings.Contains(joined, "PHPSESSID=upstreamsession123") {
		t.Fatalf("session cookie missing: %v", got)
	}
	if strings.Contains(strings.ToLower(joined), "domain=") || strings.Contains(strings.ToLower(joined), "secure") {
		t.Fatalf("Domain/Secure not stripped: %v", got)
	}

	// POST the login: the redirect must be rewritten onto our proxy path.
	req2 := withFlowCookie(httptest.NewRequest(http.MethodPost, "/api/auth/px/accounts/login", strings.NewReader("pixiv_id=x&password=y")))
	req2.Header.Set("X-Api-Key", "secret")
	req2.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusFound {
		t.Fatalf("proxied POST = %d, want 302 (body: %s)", rr2.Code, rr2.Body.String())
	}
	loc := rr2.Header().Get("Location")
	// All three kinds share ONE fake URL in the test, so any of the
	// px/<kind> prefixes is a correct rewrite (production hosts differ).
	if !strings.HasPrefix(loc, "/api/auth/px/") ||
		!strings.HasSuffix(loc, "/web/v1/users/auth/pixiv/callback?state=THE-STATE&code=THE-CODE") {
		t.Fatalf("location not rewritten: %q", loc)
	}
}

func TestAjaxLoginProxiedAndBodyRewritten(t *testing.T) {
	_, targets := fakePixivUpstream(t)
	withProxyTargets(t, targets)
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	// No flow cookie → 403 (the /ajax surface is dead outside a flow).
	req := httptest.NewRequest(http.MethodPost, "/ajax/login?lang=en", strings.NewReader("login_id=x&password=y"))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("no flow cookie = %d, want 403", rr.Code)
	}

	// With the flow cookie → proxied to accounts. The OUTER returnTo is
	// rewritten onto our proxy path; the percent-encoded INNER return_to
	// must stay untouched (pixiv validates its host server-side).
	req2 := withFlowCookie(httptest.NewRequest(http.MethodPost, "/ajax/login?lang=en", strings.NewReader("login_id=x&password=y")))
	req2.Header.Set("X-Api-Key", "secret")
	req2.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusOK {
		t.Fatalf("ajax login = %d (body: %s)", rr2.Code, rr2.Body.String())
	}
	body := rr2.Body.String()
	if !strings.Contains(body, "/api/auth/px/") {
		t.Fatalf("outer returnTo not rewritten: %s", body)
	}
	if strings.Contains(body, "http://") || strings.Contains(body, "https://") {
		t.Fatalf("raw absolute URLs left in body: %s", body)
	}
	if !strings.Contains(body, "%3A%2F%2F") {
		t.Fatalf("inner return_to should stay percent-encoded: %s", body)
	}
}

func TestPostRedirectHTMLRewritten(t *testing.T) {
	_, targets := fakePixivUpstream(t)
	withProxyTargets(t, targets)
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	req := withFlowCookie(httptest.NewRequest(http.MethodGet, "/api/auth/px/accounts/post-redirect?return_to=x", nil))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("post-redirect = %d (body: %s)", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	if !strings.Contains(body, "/api/auth/px/") || strings.Contains(body, "http://") {
		t.Fatalf("post-redirect HTML not rewritten: %s", body)
	}
}

func TestPkceStartRedirectsThroughProxy(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	req := httptest.NewRequest(http.MethodGet, "/api/auth/pkce/start", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusFound {
		t.Fatalf("start = %d, want 302", rr.Code)
	}
	loc := rr.Header().Get("Location")
	if !strings.HasPrefix(loc, "/api/auth/px/app/web/v1/login?code_challenge=") {
		t.Fatalf("start location: %q", loc)
	}
	if !strings.Contains(loc, "pixiv-android") {
		t.Fatalf("client param missing: %q", loc)
	}
	var flowCookie *http.Cookie
	for _, c := range rr.Result().Cookies() {
		if c.Name == loginFlowCookie {
			flowCookie = c
		}
	}
	if flowCookie == nil || flowCookie.Value == "" {
		t.Fatalf("login-flow cookie not set: %v", rr.Result().Cookies())
	}
	if flowCookie.Path != "/" {
		t.Fatalf("flow cookie path = %q, want /", flowCookie.Path)
	}
}

func TestPkceCallbackCompletesServerSide(t *testing.T) {
	_, targets := fakePixivUpstream(t)
	withProxyTargets(t, targets)

	var gotCode, gotVerifier string
	var setTokensCalled, setSessionCalled bool
	var setSessValue string
	f := &fakeAPI{
		pkceExchangeFn: func(code, verifier string) (string, string, int, error) {
			gotCode, gotVerifier = code, verifier
			return "rt-9", "at-9", 3600, nil
		},
		setTokensFn: func(refresh, access string, expiresIn int) error {
			setTokensCalled = true
			return nil
		},
		scrapeCsrfFn: func(phpsessid string) (string, error) {
			return "cafebabecafebabecafebabecafebabe", nil
		},
		setWebSessionFn: func(phpsessid, csrf string) error {
			setSessionCalled = true
			setSessValue = phpsessid
			return nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	// Seed the pkce store through pkce/start — the flow cookie value is
	// the verifier's key (pixiv's own state in the callback URL is
	// irrelevant to us).
	httpReq := httptest.NewRequest(http.MethodGet, "/api/auth/pkce/start", nil)
	httpReq.Header.Set("X-Api-Key", "secret")
	rr0 := httptest.NewRecorder()
	h.ServeHTTP(rr0, httpReq)
	if rr0.Code != http.StatusFound {
		t.Fatalf("start = %d, want 302", rr0.Code)
	}
	var flowID string
	for _, c := range rr0.Result().Cookies() {
		if c.Name == loginFlowCookie {
			flowID = c.Value
		}
	}
	if flowID == "" {
		t.Fatal("no flow cookie from pkce/start")
	}

	// The browser lands on the proxied callback with pixiv's state + the
	// code, carrying the flow cookie and the rewritten PHPSESSID in OUR
	// cookie jar.
	req := httptest.NewRequest(http.MethodGet,
		"/api/auth/px/app/web/v1/users/auth/pixiv/callback?state=pixivs-own-state&code=THE-CODE", nil)
	req.AddCookie(&http.Cookie{Name: loginFlowCookie, Value: flowID})
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "upstreamsession123"})
	req.AddCookie(&http.Cookie{Name: "device_token", Value: "devtok123"})
	req.AddCookie(&http.Cookie{Name: gateCookie, Value: "app-session-token"})
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusFound || rr.Header().Get("Location") != "/?auth=done" {
		t.Fatalf("callback = %d loc=%q, want 302 -> /?auth=done", rr.Code, rr.Header().Get("Location"))
	}
	if gotCode != "THE-CODE" || gotVerifier == "" {
		t.Fatalf("exchange got code=%q verifier=%q", gotCode, gotVerifier)
	}
	if !setTokensCalled {
		t.Fatal("SetTokens not called")
	}
	if !setSessionCalled || setSessValue != "upstreamsession123" {
		t.Fatalf("SetWebSession not called with the captured session (called=%v value=%q)", setSessionCalled, setSessValue)
	}

	// The callback must expire every pixiv cookie the login flow planted
	// on our origin (the session was captured server-side — the browser
	// must not keep a live copy), while OUR cookies (gate, login flow)
	// survive untouched.
	setCookies := map[string]string{}
	for _, line := range rr.Header().Values("Set-Cookie") {
		name := strings.SplitN(line, "=", 2)[0]
		setCookies[name] = line
	}
	for _, want := range []string{"PHPSESSID", "device_token"} {
		line, ok := setCookies[want]
		if !ok {
			t.Fatalf("callback did not expire %s cookie (Set-Cookie: %v)", want, rr.Header().Values("Set-Cookie"))
		}
		if !strings.Contains(line, "Max-Age=0") {
			t.Fatalf("%s expiry lacks Max-Age=0: %q", want, line)
		}
	}
	for _, forbid := range []string{gateCookie, loginFlowCookie} {
		if line, ok := setCookies[forbid]; ok {
			t.Fatalf("callback must NOT touch our own %s cookie, got: %q", forbid, line)
		}
	}
}

func TestPkceCallbackRejectsUnknownFlow(t *testing.T) {
	_, targets := fakePixivUpstream(t)
	withProxyTargets(t, targets)
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	// Flow cookie value "1" was never issued by pkce/start → the store
	// has no verifier for it.
	req := withFlowCookie(httptest.NewRequest(http.MethodGet,
		"/api/auth/px/app/web/v1/users/auth/pixiv/callback?state=pixivs-own-state&code=x", nil))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("unknown flow = %d, want 400", rr.Code)
	}
}

// ── Bookmark ids + prefs DB ───────────────────────────────────────────

func TestBookmarkIDsEndpointMergesPools(t *testing.T) {
	f := &fakeAPI{
		bookmarkIDsFn: func(restrict string, maxPages int) ([]string, error) {
			if restrict == "private" {
				return []string{"111", "222"}, nil
			}
			return []string{"222", "333"}, nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	req := httptest.NewRequest(http.MethodGet, "/api/bookmarks/ids", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("bookmark ids = %d (body: %s)", rr.Code, rr.Body.String())
	}
	var out struct {
		IDs []int `json:"ids"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("parse: %v", err)
	}
	// 222 appears in both pools — must be deduped.
	if len(out.IDs) != 3 {
		t.Fatalf("ids = %v, want 3 deduped entries", out.IDs)
	}
	seen := map[int]bool{}
	for _, id := range out.IDs {
		if seen[id] {
			t.Fatalf("duplicate id %d in response", id)
		}
		seen[id] = true
	}
}

func TestPrefsBlockedTagsRoundtripAndPersistence(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "prefs.db")
	store, err := openPrefs(dbPath)
	if err != nil {
		t.Fatalf("open prefs: %v", err)
	}

	mux := newServerBase(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20))
	registerPrefs(mux, store)
	h := apiKeyGate("secret", mux)

	// PUT the list (dedupe + trim + lowercase applied server-side).
	req := httptest.NewRequest(http.MethodPut, "/api/prefs/blocked-tags",
		strings.NewReader(`{"tags":[" Loli ","loli","Swimsuit",""]}`))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT = %d (body: %s)", rr.Code, rr.Body.String())
	}
	var putOut struct {
		Tags []string `json:"tags"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &putOut); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(putOut.Tags) != 2 || putOut.Tags[0] != "loli" || putOut.Tags[1] != "swimsuit" {
		t.Fatalf("cleaned tags = %v, want [loli swimsuit]", putOut.Tags)
	}

	// Reopen the DB fresh — the list must survive (the whole point of
	// moving prefs out of localStorage).
	store2, err := openPrefs(dbPath)
	if err != nil {
		t.Fatalf("reopen prefs: %v", err)
	}
	mux2 := newServerBase(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20))
	registerPrefs(mux2, store2)
	h2 := apiKeyGate("secret", mux2)

	req2 := httptest.NewRequest(http.MethodGet, "/api/prefs/blocked-tags", nil)
	req2.Header.Set("X-Api-Key", "secret")
	rr2 := httptest.NewRecorder()
	h2.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusOK {
		t.Fatalf("GET = %d", rr2.Code)
	}
	var getOut struct {
		Tags []string `json:"tags"`
	}
	if err := json.Unmarshal(rr2.Body.Bytes(), &getOut); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(getOut.Tags) != 2 || getOut.Tags[0] != "loli" || getOut.Tags[1] != "swimsuit" {
		t.Fatalf("persisted tags = %v, want [loli swimsuit]", getOut.Tags)
	}
}

func TestPrefsBlockedTagsRejectsOversizedList(t *testing.T) {
	store, err := openPrefs(":memory:")
	if err != nil {
		t.Fatalf("open prefs: %v", err)
	}
	mux := newServerBase(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20))
	registerPrefs(mux, store)
	h := apiKeyGate("secret", mux)

	many := make([]string, 201)
	for i := range many {
		many[i] = fmt.Sprintf("tag%d", i)
	}
	body, _ := json.Marshal(map[string]any{"tags": many})
	req := httptest.NewRequest(http.MethodPut, "/api/prefs/blocked-tags", bytes.NewReader(body))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("oversized list = %d, want 400", rr.Code)
	}
}

// ── Search ─────────────────────────────────────────────────────────────

const searchFakeResp = `{
  "error": false,
  "body": {
    "illustManga": {
      "data": [
        {"id":"111","title":"Work one","type":"illust","illustType":0,
         "userId":"9","userName":"ArtistA","url":"https://i.pximg.net/c/360x360_70/img-master/img/1/111_p0_square1200.jpg",
         "pageCount":1,"width":1000,"height":1000,"tags":["オリジナル"],"xRestrict":0,"aiType":2,"bookmarkData":null},
        {"id":"112","title":"Work two","type":"illust","illustType":0,
         "userId":"9","userName":"ArtistA","url":"https://i.pximg.net/c/360x360_70/img-master/img/1/112_p0_square1200.jpg",
         "pageCount":1,"width":1000,"height":1000,"tags":["fantasy"],"xRestrict":0,"aiType":1,"bookmarkData":{"id":"b9"}}
      ],
      "total": 900, "lastPage": 100
    },
    "popular": {
      "recent": [
        {"id":"200","title":"Pop","type":"illust","illustType":0,
         "userId":"5","userName":"PopArtist","url":"https://i.pximg.net/c/360x360_70/img-master/img/2/200_p0_square1200.jpg",
         "pageCount":1,"width":500,"height":500,"tags":[],"xRestrict":0,"aiType":1,"bookmarkData":null}
      ],
      "permanent": []
    },
    "relatedTags": ["幻想", "Fantasy"],
    "tagTranslation": {"幻想": {"en": "fantasy"}}
  }
}`

func TestSearchArtworksEndpoint(t *testing.T) {
	var gotWord string
	var gotOpts pixiv.SearchOpts
	var gotPage int
	f := &fakeAPI{
		searchArtFn: func(word string, opts pixiv.SearchOpts, page int) ([]byte, error) {
			gotWord, gotOpts, gotPage = word, opts, page
			return []byte(searchFakeResp), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	req := httptest.NewRequest(http.MethodGet,
		"/api/search/artworks?word=fantasy&order=date&mode=r18&s_mode=s_tc&type=illust&ai_type=1&scd=2026-06-01&sce=2026-06-30&p=3", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("search = %d (body: %s)", rr.Code, rr.Body.String())
	}
	if gotWord != "fantasy" || gotOpts.Order != "date" || gotOpts.Mode != "r18" || gotOpts.SMode != "s_tc" ||
		gotOpts.Type != "illust" || gotOpts.AIType != "1" || gotOpts.SCD != "2026-06-01" || gotOpts.SCE != "2026-06-30" || gotPage != 3 {
		t.Fatalf("client got word=%q opts=%+v page=%d", gotWord, gotOpts, gotPage)
	}

	var out struct {
		Illusts []struct {
			ID           string `json:"id"`
			IsBookmarked bool   `json:"is_bookmarked"`
		} `json:"illusts"`
		Total    int     `json:"total"`
		LastPage int     `json:"last_page"`
		Page     int     `json:"page"`
		NextURL  *string `json:"next_url"`
		Popular  []struct {
			ID string `json:"id"`
		} `json:"popular"`
		RelatedTags []struct {
			Name           string `json:"name"`
			TranslatedName string `json:"translated_name"`
		} `json:"related_tags"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Illusts) != 2 || out.Illusts[0].ID != "111" || !out.Illusts[1].IsBookmarked {
		t.Fatalf("illusts wrong: %+v", out.Illusts)
	}
	if out.Total != 900 || out.LastPage != 100 || out.Page != 3 {
		t.Fatalf("meta wrong: %+v", out)
	}
	if out.NextURL == nil || !strings.Contains(*out.NextURL, "p=4") {
		t.Fatalf("next_url wrong: %v", out.NextURL)
	}
	// Every filter param must ride through next_url (the FE paginates
	// via it, so a dropped filter would silently reset on page 2+).
	for _, want := range []string{"order=date", "mode=r18", "s_mode=s_tc", "type=illust", "ai_type=1", "scd=2026-06-01", "sce=2026-06-30"} {
		if !strings.Contains(*out.NextURL, want) {
			t.Fatalf("next_url missing %q: %v", want, *out.NextURL)
		}
	}
	if len(out.Popular) != 1 || out.Popular[0].ID != "200" {
		t.Fatalf("popular block missing: %+v", out.Popular)
	}
	if len(out.RelatedTags) != 2 || out.RelatedTags[0].TranslatedName != "fantasy" {
		t.Fatalf("related tags wrong: %+v", out.RelatedTags)
	}
}

func TestSearchArtworksDefaults(t *testing.T) {
	var gotOpts pixiv.SearchOpts
	f := &fakeAPI{
		searchArtFn: func(word string, opts pixiv.SearchOpts, page int) ([]byte, error) {
			gotOpts = opts
			return []byte(searchFakeResp), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	req := httptest.NewRequest(http.MethodGet, "/api/search/artworks?word=x", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("defaults = %d", rr.Code)
	}
	if gotOpts.Order != "date_d" || gotOpts.Mode != "all" || gotOpts.SMode != "s_tag_full" || gotOpts.Type != "all" || gotOpts.AIType != "0" {
		t.Fatalf("defaults wrong: %+v", gotOpts)
	}
}

func TestSearchArtworksRejectsInvalidPage(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	req := httptest.NewRequest(http.MethodGet, "/api/search/artworks?word=x&p=0", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("p=0 = %d, want 400", rr.Code)
	}
}

const searchUsersFakeResp = `{
  "error": false,
  "body": {
    "users": [
      {"userId":"77","name":"User One","image":"https://i.pximg.net/user-profile/img/1.jpg","premium":false,"isFollowed":false}
    ],
    "thumbnails": {"illust": [
      {"id":"300","title":"Their work","type":"illust","illustType":0,
       "userId":"77","userName":"User One","url":"https://i.pximg.net/c/360x360_70/img-master/img/3/300_p0_square1200.jpg",
       "pageCount":1,"width":600,"height":600,"tags":[],"xRestrict":0,"aiType":1,"bookmarkData":null}
    ]},
    "page": {"workIds": {"77": [{"id":"300","type":"illust"}]}, "total": 622}
  }
}`

func TestSearchUsersEndpoint(t *testing.T) {
	f := &fakeAPI{
		searchUsrFn: func(nick, sMode string, page int) ([]byte, error) {
			return []byte(searchUsersFakeResp), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")

	req := httptest.NewRequest(http.MethodGet, "/api/search/users?nick=fantasy&p=1", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("user search = %d (body: %s)", rr.Code, rr.Body.String())
	}
	var out struct {
		Users []struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Avatar   string `json:"avatar"`
			Previews []struct {
				ID string `json:"id"`
			} `json:"previews"`
		} `json:"users"`
		Total   int     `json:"total"`
		NextURL *string `json:"next_url"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Users) != 1 || out.Users[0].ID != "77" || out.Users[0].Name != "User One" {
		t.Fatalf("users wrong: %+v", out.Users)
	}
	if len(out.Users[0].Previews) != 1 || out.Users[0].Previews[0].ID != "300" {
		t.Fatalf("previews wrong: %+v", out.Users[0].Previews)
	}
	if out.Total != 622 || out.NextURL == nil || !strings.Contains(*out.NextURL, "p=2") {
		t.Fatalf("pagination wrong: total=%d next=%v", out.Total, out.NextURL)
	}
}

func TestBookmarksPageEndpoint(t *testing.T) {
	// A one-work page from the crawl-verified web-AJAX shape.
	pageJSON := `{"error":false,"message":"","body":{"works":[{
		"id":"148045266","title":"Remielle","illustType":0,"xRestrict":0,"restrict":0,
		"url":"https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/08/05/15/53/58/148045266_p0_square1200.jpg",
		"tags":["ZZZ"],"userId":"83540148","userName":"swean","width":2048,"height":3072,
		"pageCount":1,"isBookmarkable":true,
		"bookmarkData":{"id":"38388957251","private":false},
		"aiType":2,"profileImageUrl":"https://i.pximg.net/user-profile/img/1_50.gif"
	}],"total":12504}}`
	f := &fakeAPI{
		bookmarkPageFn: func(tag string, offset, limit int, order string) ([]byte, error) {
			if tag != "abc" || offset != 48 || limit != 48 || order != "asc" {
				t.Fatalf("page args = %q/%d/%d/%q", tag, offset, limit, order)
			}
			return []byte(pageJSON), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	req := httptest.NewRequest(http.MethodGet, "/api/bookmarks?tag=abc&offset=48&order=asc", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("bookmarks = %d (body: %s)", rr.Code, rr.Body.String())
	}
	var out struct {
		Illusts []struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		} `json:"illusts"`
		NextURL *string `json:"next_url"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(out.Illusts) != 1 || out.Illusts[0].ID != "148045266" {
		t.Fatalf("illusts wrong: %+v", out.Illusts)
	}
	// Blind offset pagination: offset+48 < total → next_url built locally.
	wantNext := "/api/bookmarks?tag=abc&offset=96&order=asc"
	if out.NextURL == nil || *out.NextURL != wantNext {
		t.Fatalf("next_url = %v, want %q", out.NextURL, wantNext)
	}
}

func TestBookmarksPageNextURLTerminates(t *testing.T) {
	// offset 48 + limit 48 == total 96 → next_url must be null.
	f := &fakeAPI{
		bookmarkPageFn: func(tag string, offset, limit int, order string) ([]byte, error) {
			return []byte(`{"error":false,"message":"","body":{"works":[],"total":96}}`), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	req := httptest.NewRequest(http.MethodGet, "/api/bookmarks?offset=48", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("bookmarks = %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), `"next_url":null`) {
		t.Fatalf("next_url not null at the end: %s", rr.Body.String())
	}
}

func TestBookmarksPageRejectsBadParams(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	for _, q := range []string{"?offset=-1", "?offset=abc", "?offset=999999", "?order=sideways", "?tag=" + strings.Repeat("x", 65)} {
		req := httptest.NewRequest(http.MethodGet, "/api/bookmarks"+q, nil)
		req.Header.Set("X-Api-Key", "secret")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("GET /api/bookmarks%s = %d, want 400", q, rr.Code)
		}
	}
}

func TestBookmarksTagsEndpoint(t *testing.T) {
	f := &fakeAPI{
		bookmarkTagsFn: func() ([]byte, error) {
			return []byte(`{"error":false,"message":"","body":{"public":[{"tag":"未分類","cnt":12504}],"private":[{"tag":"未分類","cnt":2418}]}}`), nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	req := httptest.NewRequest(http.MethodGet, "/api/bookmarks/tags", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("tags = %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), `"name":"未分類"`) || !strings.Contains(rr.Body.String(), `"count":12504`) {
		t.Fatalf("tags shape wrong: %s", rr.Body.String())
	}
}

func TestFollowRoutes(t *testing.T) {
	var gotAdd, gotDel, gotState string
	f := &fakeAPI{
		setFollowFn: func(userID, restrict string, follow bool) error {
			if userID != "12345" || restrict != "public" {
				t.Fatalf("setFollow(%q, %q)", userID, restrict)
			}
			if follow {
				gotAdd = userID
			} else {
				gotDel = userID
			}
			return nil
		},
		isFollowedFn: func(userID string) (bool, error) {
			gotState = userID
			return true, nil
		},
	}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	post := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.Header.Set("X-Api-Key", "secret")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}
	if rr := post("/api/user/12345/follow"); rr.Code != http.StatusOK || gotAdd != "12345" {
		t.Fatalf("follow = %d, add=%q", rr.Code, gotAdd)
	}
	if rr := post("/api/user/12345/unfollow"); rr.Code != http.StatusOK || gotDel != "12345" {
		t.Fatalf("unfollow = %d, del=%q", rr.Code, gotDel)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/user/12345/followed", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"followed":true`) || gotState != "12345" {
		t.Fatalf("followed = %d %s state=%q", rr.Code, rr.Body.String(), gotState)
	}
}

func TestFollowRoutesRejectBadInput(t *testing.T) {
	f := &fakeAPI{}
	h := newServer(f, newImageCache(time.Hour, 10, 512<<20), "secret")
	// Bad id.
	req := httptest.NewRequest(http.MethodPost, "/api/user/abc/follow", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("bad id = %d, want 400", rr.Code)
	}
	// GET must not mutate: no follow route matches GET — the artist
	// subtree catches it (404). The mutation itself is POST-only.
	req = httptest.NewRequest(http.MethodGet, "/api/user/12345/follow", nil)
	req.Header.Set("X-Api-Key", "secret")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("GET follow = %d, want 404", rr.Code)
	}
}

// ── Password gate ──────────────────────────────────────────────────────

func newGatedServer(t *testing.T, password string) http.Handler {
	t.Helper()
	g, err := newGate(password, true) // plaintext passwords are test fixtures
	if err != nil {
		t.Fatalf("newGate: %v", err)
	}
	mux := newServerBase(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20))
	registerGateRoutes(mux, g)
	return apiKeyGate("secret", g.middleware(mux))
}

func TestGateLocksEverythingUntilUnlocked(t *testing.T) {
	h := newGatedServer(t, "correct horse battery staple")

	// No cookie → every API route 403s.
	req := httptest.NewRequest(http.MethodPost, "/api/street", strings.NewReader("{}"))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("gated street = %d, want 403", rr.Code)
	}

	// Status reports locked.
	req2 := httptest.NewRequest(http.MethodGet, "/api/gate/status", nil)
	req2.Header.Set("X-Api-Key", "secret")
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusOK || !strings.Contains(rr2.Body.String(), `"locked":true`) {
		t.Fatalf("status = %d %s", rr2.Code, rr2.Body.String())
	}

	// Wrong password → 401, still locked.
	req3 := httptest.NewRequest(http.MethodPost, "/api/gate",
		strings.NewReader(`{"password":"wrong"}`))
	req3.Header.Set("X-Api-Key", "secret")
	req3.Header.Set("Content-Type", "application/json")
	rr3 := httptest.NewRecorder()
	h.ServeHTTP(rr3, req3)
	if rr3.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password = %d, want 401", rr3.Code)
	}

	// Correct password → cookie issued.
	req4 := httptest.NewRequest(http.MethodPost, "/api/gate",
		strings.NewReader(`{"password":"correct horse battery staple"}`))
	req4.Header.Set("X-Api-Key", "secret")
	req4.Header.Set("Content-Type", "application/json")
	rr4 := httptest.NewRecorder()
	h.ServeHTTP(rr4, req4)
	if rr4.Code != http.StatusOK {
		t.Fatalf("unlock = %d (body: %s)", rr4.Code, rr4.Body.String())
	}
	var cookie *http.Cookie
	for _, c := range rr4.Result().Cookies() {
		if c.Name == gateCookie {
			cookie = c
		}
	}
	if cookie == nil || cookie.Value == "" || !cookie.HttpOnly {
		t.Fatalf("gate cookie missing or wrong: %v", rr4.Result().Cookies())
	}

	// The cookie opens the API.
	req5 := httptest.NewRequest(http.MethodPost, "/api/street", strings.NewReader("{}"))
	req5.Header.Set("X-Api-Key", "secret")
	req5.AddCookie(cookie)
	rr5 := httptest.NewRecorder()
	h.ServeHTTP(rr5, req5)
	if rr5.Code != http.StatusOK {
		t.Fatalf("unlocked street = %d, want 200", rr5.Code)
	}

	// Status reports unlocked.
	req6 := httptest.NewRequest(http.MethodGet, "/api/gate/status", nil)
	req6.Header.Set("X-Api-Key", "secret")
	req6.AddCookie(cookie)
	rr6 := httptest.NewRecorder()
	h.ServeHTTP(rr6, req6)
	if rr6.Code != http.StatusOK || !strings.Contains(rr6.Body.String(), `"locked":false`) {
		t.Fatalf("status after unlock = %d %s", rr6.Code, rr6.Body.String())
	}
}

func TestSecureForRequest(t *testing.T) {
	mk := func(fn func(*http.Request)) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		fn(r)
		return r
	}
	cases := []struct {
		name string
		flag string
		req  *http.Request
		want bool
	}{
		{"flag off, plain", "false", mk(func(r *http.Request) {}), false},
		{"flag off, forwarded https", "false", mk(func(r *http.Request) {
			r.Header.Set("X-Forwarded-Proto", "https")
		}), false},
		{"flag on, plain", "true", mk(func(r *http.Request) {}), false},
		{"flag on, forwarded http", "true", mk(func(r *http.Request) {
			r.Header.Set("X-Forwarded-Proto", "http")
		}), false},
		{"flag on, forwarded https", "true", mk(func(r *http.Request) {
			r.Header.Set("X-Forwarded-Proto", "https")
		}), true},
		{"flag on, forwarded HTTPS mixed case", "true", mk(func(r *http.Request) {
			r.Header.Set("X-Forwarded-Proto", "HTTPS")
		}), true},
		{"flag on, direct TLS", "true", mk(func(r *http.Request) {
			r.TLS = &tls.ConnectionState{}
		}), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("PIXTOK_PUBLIC_HTTPS", c.flag)
			if got := secureForRequest(c.req); got != c.want {
				t.Fatalf("secureForRequest = %v, want %v", got, c.want)
			}
		})
	}
}

// Regression: PIXTOK_PUBLIC_HTTPS=true used to stamp Secure on the gate
// cookie for EVERY request, including plain-HTTP ones (localhost, direct
// tailnet URL). Browsers store a Secure cookie but never send it over
// HTTP, so the login "succeeded" and every follow-up request 403'd —
// the whole app dead for HTTP origins.
func TestGateCookieSecureFollowsRequestTransport(t *testing.T) {
	t.Setenv("PIXTOK_PUBLIC_HTTPS", "true")
	h := newGatedServer(t, "correct horse battery staple")

	unlock := func(t *testing.T, mutate func(*http.Request)) *http.Cookie {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/gate",
			strings.NewReader(`{"password":"correct horse battery staple"}`))
		req.Header.Set("X-Api-Key", "secret")
		req.Header.Set("Content-Type", "application/json")
		if mutate != nil {
			mutate(req)
		}
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("unlock = %d (body: %s)", rr.Code, rr.Body.String())
		}
		for _, c := range rr.Result().Cookies() {
			if c.Name == gateCookie {
				return c
			}
		}
		t.Fatal("no gate cookie in unlock response")
		return nil
	}

	// Plain HTTP transport: cookie must NOT be Secure.
	if c := unlock(t, nil); c.Secure {
		t.Fatal("plain HTTP unlock got a Secure cookie — the browser would never send it back over HTTP")
	}

	// Funnel: TLS terminated upstream, request tagged X-Forwarded-Proto.
	if c := unlock(t, func(r *http.Request) {
		r.Header.Set("X-Forwarded-Proto", "https")
	}); !c.Secure {
		t.Fatal("funnel (X-Forwarded-Proto: https) unlock lost Secure")
	}

	// Flag off: never Secure, even with the forwarded proto.
	t.Setenv("PIXTOK_PUBLIC_HTTPS", "false")
	if c := unlock(t, func(r *http.Request) {
		r.Header.Set("X-Forwarded-Proto", "https")
	}); c.Secure {
		t.Fatal("Secure set with PIXTOK_PUBLIC_HTTPS disabled")
	}
}

func TestGateDisabledWithoutPassword(t *testing.T) {
	g, err := newGate("", false)
	if err != nil {
		t.Fatalf("newGate: %v", err)
	}
	mux := newServerBase(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20))
	registerGateRoutes(mux, g)
	h := apiKeyGate("secret", g.middleware(mux))

	req := httptest.NewRequest(http.MethodPost, "/api/street", strings.NewReader("{}"))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("disabled gate blocks = %d, want 200", rr.Code)
	}
}

func TestPrefsViewModesDefaultAndRoundtrip(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "prefs.db")
	store, err := openPrefs(dbPath)
	if err != nil {
		t.Fatalf("open prefs: %v", err)
	}
	mux := newServerBase(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20))
	registerPrefs(mux, store)
	h := apiKeyGate("secret", mux)

	paths := []string{"/api/prefs/feed-view-mode", "/api/prefs/artist-view-mode"}

	// Never-set modes read as the strip default.
	for _, path := range paths {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("X-Api-Key", "secret")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("GET %s default = %d", path, rr.Code)
		}
		var out struct {
			Value string `json:"value"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatalf("parse: %v", err)
		}
		if out.Value != "strip" {
			t.Fatalf("default %s = %q, want strip", path, out.Value)
		}
	}

	// PUT both to grid.
	for _, path := range paths {
		req := httptest.NewRequest(http.MethodPut, path,
			strings.NewReader(`{"value":"grid"}`))
		req.Header.Set("X-Api-Key", "secret")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("PUT %s = %d (body: %s)", path, rr.Code, rr.Body.String())
		}
	}

	// Reopen the DB fresh — both modes must survive (the whole point of
	// keeping view modes in the prefs DB instead of localStorage).
	store2, err := openPrefs(dbPath)
	if err != nil {
		t.Fatalf("reopen prefs: %v", err)
	}
	if v, err := store2.GetFeedViewMode(); err != nil || v != "grid" {
		t.Fatalf("persisted feed mode = %q, %v; want grid", v, err)
	}
	if v, err := store2.GetArtistViewMode(); err != nil || v != "grid" {
		t.Fatalf("persisted artist mode = %q, %v; want grid", v, err)
	}
}

func TestPrefsViewModesRejectInvalid(t *testing.T) {
	store, err := openPrefs(":memory:")
	if err != nil {
		t.Fatalf("open prefs: %v", err)
	}
	mux := newServerBase(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20))
	registerPrefs(mux, store)
	h := apiKeyGate("secret", mux)

	for _, path := range []string{"/api/prefs/feed-view-mode", "/api/prefs/artist-view-mode"} {
		req := httptest.NewRequest(http.MethodPut, path,
			strings.NewReader(`{"value":"carousel"}`))
		req.Header.Set("X-Api-Key", "secret")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("PUT %s invalid = %d, want 400", path, rr.Code)
		}
		// The invalid write must not have touched the stored value.
		req2 := httptest.NewRequest(http.MethodGet, path, nil)
		req2.Header.Set("X-Api-Key", "secret")
		rr2 := httptest.NewRecorder()
		h.ServeHTTP(rr2, req2)
		if rr2.Code != http.StatusOK {
			t.Fatalf("GET %s after invalid PUT = %d", path, rr2.Code)
		}
		var out struct {
			Value string `json:"value"`
		}
		if err := json.Unmarshal(rr2.Body.Bytes(), &out); err != nil {
			t.Fatalf("parse: %v", err)
		}
		if out.Value != "strip" {
			t.Fatalf("value after invalid PUT = %q, want strip", out.Value)
		}
	}
}

// Method enforcement, malformed bodies, the body cap, and value trimming
// on the prefs routes — the view-mode routes shipped without any of
// these covered.
func TestPrefsRoutesEnforceMethodBodyCapAndTrim(t *testing.T) {
	store, err := openPrefs(":memory:")
	if err != nil {
		t.Fatalf("open prefs: %v", err)
	}
	mux := newServerBase(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20))
	registerPrefs(mux, store)
	h := apiKeyGate("secret", mux)

	paths := []string{
		"/api/prefs/feed-view-mode",
		"/api/prefs/artist-view-mode",
		"/api/prefs/image-size",
	}
	for _, path := range paths {
		// 405 on unhandled methods.
		for _, method := range []string{http.MethodPost, http.MethodDelete} {
			req := httptest.NewRequest(method, path, nil)
			req.Header.Set("X-Api-Key", "secret")
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s = %d, want 405", method, path, rr.Code)
			}
		}
		// Malformed JSON → 400.
		req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(`{nope`))
		req.Header.Set("X-Api-Key", "secret")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("malformed PUT %s = %d, want 400", path, rr.Code)
		}
		// Oversized body (>4KB cap) → 400.
		req = httptest.NewRequest(http.MethodPut, path,
			strings.NewReader(`{"value":"`+strings.Repeat("x", 5000)+`"}`))
		req.Header.Set("X-Api-Key", "secret")
		rr = httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("oversized PUT %s = %d, want 400", path, rr.Code)
		}
	}

	// Values are trimmed before validation/storage (" grid " == "grid").
	req := httptest.NewRequest(http.MethodPut, "/api/prefs/feed-view-mode",
		strings.NewReader(`{"value":" grid "}`))
	req.Header.Set("X-Api-Key", "secret")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("trimmed PUT = %d, want 200 (body: %s)", rr.Code, rr.Body.String())
	}
	if v, err := store.GetFeedViewMode(); err != nil || v != "grid" {
		t.Fatalf("stored value = %q, %v; want grid (trimmed)", v, err)
	}
}

func (f *fakeAPI) GetBookmarkPage(tag string, offset, limit int, order string) ([]byte, error) {
	if f.bookmarkPageFn != nil {
		return f.bookmarkPageFn(tag, offset, limit, order)
	}
	return []byte(`{"error":false,"message":"","body":{"works":[],"total":0}}`), nil
}

func (f *fakeAPI) GetBookmarkTags() ([]byte, error) {
	if f.bookmarkTagsFn != nil {
		return f.bookmarkTagsFn()
	}
	return []byte(`{"error":false,"message":"","body":{"public":[],"private":[]}}`), nil
}

func (f *fakeAPI) SetFollow(userID, restrict string, follow bool) error {
	if f.setFollowFn != nil {
		return f.setFollowFn(userID, restrict, follow)
	}
	return nil
}

func (f *fakeAPI) IsFollowed(userID string) (bool, error) {
	if f.isFollowedFn != nil {
		return f.isFollowedFn(userID)
	}
	return false, nil
}

func TestClientLogEndpoint(t *testing.T) {
	h := newServerBase(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20))

	var buf bytes.Buffer
	orig := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(orig)

	// Valid breadcrumb → 200 + journal line tagged with the session.
	req := httptest.NewRequest(http.MethodPost, "/api/log",
		strings.NewReader(`{"session":"abc123","scope":"gesture","msg":"pop","data":{"dx":90,"top":"s1"}}`))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("log = %d, want 200", rr.Code)
	}
	if !strings.Contains(buf.String(), "CLIENT [abc123] gesture: pop") {
		t.Fatalf("journal line missing: %q", buf.String())
	}

	// Unknown scope → 400.
	req2 := httptest.NewRequest(http.MethodPost, "/api/log",
		strings.NewReader(`{"session":"abc123","scope":"evil","msg":"x"}`))
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, req2)
	if rr2.Code != http.StatusBadRequest {
		t.Fatalf("bad scope = %d, want 400", rr2.Code)
	}

	// Malformed JSON → 400.
	req3 := httptest.NewRequest(http.MethodPost, "/api/log", strings.NewReader("{nope"))
	rr3 := httptest.NewRecorder()
	h.ServeHTTP(rr3, req3)
	if rr3.Code != http.StatusBadRequest {
		t.Fatalf("bad json = %d, want 400", rr3.Code)
	}
}
