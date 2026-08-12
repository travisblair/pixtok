package pixiv

import (
	"errors"
	"net/http"
	"testing"
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
