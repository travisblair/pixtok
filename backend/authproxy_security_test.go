package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

// ── Login proxy: exact-host rewrite (reviewer finding) ────────────────
//
// The Location/body rewrites must map ONLY Pixiv-owned hosts onto the
// proxy paths. These tables pin the whole confusion class: suffix
// domains, userinfo tricks, wrong schemes, wrong ports, relative URLs.

func TestRewriteLocationExactHost(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string // rewritten output; empty = must stay unchanged
	}{
		{"absolute accounts", "https://accounts.pixiv.net/foo", "/api/auth/px/accounts/foo"},
		{"accounts port 443", "https://accounts.pixiv.net:443/foo", "/api/auth/px/accounts/foo"},
		{"query preserved", "https://accounts.pixiv.net/foo?x=1&y=2", "/api/auth/px/accounts/foo?x=1&y=2"},
		{"fragment preserved", "https://accounts.pixiv.net/foo#frag", "/api/auth/px/accounts/foo#frag"},
		{"suffix domain", "https://accounts.pixiv.net.evil.example/foo", ""},
		{"hostname-as-userinfo", "https://accounts.pixiv.net@evil.example/foo", ""},
		{"userinfo on real host", "https://evil@accounts.pixiv.net/foo", "/api/auth/px/accounts/foo"},
		{"scheme-relative", "//accounts.pixiv.net/foo", "/api/auth/px/accounts/foo"},
		{"scheme-relative suffix", "//accounts.pixiv.net.evil.example/foo", ""},
		{"www", "https://www.pixiv.net/foo", "/api/auth/px/www/foo"},
		{"oauth", "https://oauth.secure.pixiv.net/foo", "/api/auth/px/oauth/foo"},
		{"app api", "https://app-api.pixiv.net/v1/x", "/api/auth/px/app/v1/x"},
		{"http scheme", "http://accounts.pixiv.net/foo", ""},
		{"bad port", "https://accounts.pixiv.net:8443/foo", ""},
		{"javascript scheme", "javascript:alert(1)", ""},
		{"relative path", "/relative/path", ""},
		{"unrelated host", "https://example.com/foo", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rewriteLocation(tc.in)
			if tc.want == "" {
				if got != tc.in {
					t.Fatalf("rewriteLocation(%q) = %q, want unchanged", tc.in, got)
				}
				return
			}
			if got != tc.want {
				t.Fatalf("rewriteLocation(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestRewriteBodyURLsSuffixDomain(t *testing.T) {
	body := []byte(`{"returnTo":"https://accounts.pixiv.net/post-redirect?foo","evil":"https://accounts.pixiv.net.evil.example/x","escEvil":"https:\/\/accounts.pixiv.net.evil.example\/x","protoRel":"//www.pixiv.net/foo","escaped":"https:\/\/accounts.pixiv.net\/bar"}`)
	got := string(rewriteBodyURLs(body))

	for _, want := range []string{
		`"returnTo":"/api/auth/px/accounts/post-redirect?foo"`,
		`"protoRel":"/api/auth/px/www/foo"`,
		// Escaped form: the host is rewritten, the path keeps its
		// json_encode "\/" escaping (the browser decodes it back to
		// "/" when it parses the JSON).
		`"escaped":"/api/auth/px/accounts\/bar"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("rewritten body missing %s\ngot: %s", want, got)
		}
	}
	// The suffix-domain lookalikes must survive VERBATIM (untouched),
	// and must never be rewritten onto the proxy path.
	for _, want := range []string{
		`"evil":"https://accounts.pixiv.net.evil.example/x"`,
		`"escEvil":"https:\/\/accounts.pixiv.net.evil.example\/x"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("lookalike URL was modified\ngot: %s", got)
		}
	}
	for _, forbidden := range []string{
		`"evil":"/api/auth/px/`,
		`"escEvil":"/api/auth/px/`,
	} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("suffix-domain lookalike was rewritten onto the proxy path: %s\ngot: %s", forbidden, got)
		}
	}
}

func TestRewriteCookieStripsDomainAlways(t *testing.T) {
	in := "PHPSESSID=abc123; Domain=.pixiv.net; Path=/; Secure; HttpOnly"
	got := rewriteCookie(in)
	if strings.Contains(got, "Domain") {
		t.Fatalf("Domain= survived: %q", got)
	}
	if !strings.Contains(got, "PHPSESSID=abc123") {
		t.Fatalf("cookie value lost: %q", got)
	}
	if !strings.Contains(got, "HttpOnly") {
		t.Fatalf("HttpOnly lost: %q", got)
	}
	// Secure depends on deployment — on HTTP dev it must go (browser
	// would refuse the cookie), on HTTPS public it must stay.
	t.Setenv("PIXTOK_PUBLIC_HTTPS", "true")
	if !strings.Contains(rewriteCookie(in), "Secure") {
		t.Fatalf("Secure stripped under HTTPS deployment")
	}
	t.Setenv("PIXTOK_PUBLIC_HTTPS", "false")
	if strings.Contains(rewriteCookie(in), "Secure") {
		t.Fatalf("Secure kept under HTTP dev — cookie would never store")
	}
}

// ── Gate: fail-closed plaintext (reviewer finding) ────────────────────

func TestGateRejectsPlaintextWithoutFlag(t *testing.T) {
	if _, err := newGate("plaintext-pass", false); err == nil {
		t.Fatal("plaintext password accepted without PIXTOK_GATE_ALLOW_PLAINTEXT_DEV_ONLY — fail-closed regression")
	}
}

func TestGateAcceptsPlaintextWithFlag(t *testing.T) {
	g, err := newGate("plaintext-pass", true)
	if err != nil {
		t.Fatalf("newGate(plaintext, allow) = %v", err)
	}
	if !g.enabled {
		t.Fatal("gate not enabled with plaintext + dev flag")
	}
}

func TestGateAcceptsBcryptHashWithoutFlag(t *testing.T) {
	h, err := bcrypt.GenerateFromPassword([]byte("secret"), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt: %v", err)
	}
	g, err := newGate(string(h), false)
	if err != nil {
		t.Fatalf("newGate(bcrypt) = %v", err)
	}
	if !g.enabled {
		t.Fatal("gate not enabled with a valid bcrypt hash")
	}
}

// ── Security headers middleware (reviewer finding) ────────────────────

func TestSecurityHeadersMiddleware(t *testing.T) {
	h := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/health", nil))
	for k, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
	} {
		if got := rr.Header().Get(k); got != want {
			t.Fatalf("%s = %q, want %q", k, got, want)
		}
	}
}
