package pixiv

// /api/next least-privilege (review finding L6). The relay signs a GET
// with the owner's bearer token; it must accept only the pagination URLs
// this app itself hands to the client, not any app-API GET.

import (
	"errors"
	"testing"
)

func TestNextURLPathAllowlist(t *testing.T) {
	// Every shape the app actually receives as an absolute next_url.
	allowed := []string{
		"/v1/illust/ranking",
		"/v1/illust/recommended",
		"/v2/illust/related",
		"/v1/user/illusts",
		"/v1/user/bookmarks/illust",
	}
	for _, p := range allowed {
		if !nextURLPathAllowed(p) {
			t.Errorf("pagination path %q rejected", p)
		}
	}

	// Endpoints the UI never exposes to /api/next, and the dot-segment
	// shape a prefix match would have let through.
	rejected := []string{
		"/v1/user/detail",
		"/v1/user/follow/add",
		"/v2/illust/bookmark/add",
		"/v1/illust/detail",
		"/v1/illust/ranking/../user/detail",
		"/v1/illust/ranking/extra",
		"/v1/illust/recommended-nologin",
		"",
	}
	for _, p := range rejected {
		if nextURLPathAllowed(p) {
			t.Errorf("non-pagination path %q accepted", p)
		}
	}
}

// ProxyNext must refuse a non-pagination URL BEFORE it touches the
// network. The client here has no HTTP client at all: if the check were
// missing, the call would panic reaching the transport instead of
// returning a typed refusal.
func TestProxyNextRejectsNonPaginationPath(t *testing.T) {
	c := &Client{}

	cases := []string{
		"https://app-api.pixiv.net/v1/user/detail?user_id=123",
		"https://app-api.pixiv.net/v2/illust/bookmark/add",
		"https://app-api.pixiv.net/v1/illust/ranking/../user/detail",
		"https://app-api.pixiv.net/v1/illust/recommended-nologin",
		"https://user:pass@app-api.pixiv.net/v1/user/detail",
		"https://evil.example/v1/illust/ranking",
		"http://app-api.pixiv.net/v1/illust/ranking",
	}
	for _, raw := range cases {
		_, err := c.ProxyNext(raw)
		if !errors.Is(err, ErrInvalidParam) {
			t.Errorf("ProxyNext(%q) = %v, want ErrInvalidParam", raw, err)
		}
	}
}
