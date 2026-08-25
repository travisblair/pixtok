package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ── Proxied in-app login ────────────────────────────────────────────────
//
// pixiv's own login pages are served THROUGH this backend so the phone
// browser stays on our origin the whole time: Set-Cookie headers get
// their Domain=/Secure= attributes stripped (pixiv's session cookies
// become host-only for OUR origin — the backend then reads them off the
// callback request), and the PKCE callback is intercepted server-side:
// code → refresh token, PHPSESSID → web session. One tap on the phone,
// one login, everything captured. Verified viable Aug 2026: a proxied
// junk-credential submit returned pixiv's standard wrong-password error
// (the whole chain upstream of the password check works, including a
// foreign-origin reCAPTCHA Enterprise token).

// authProxyTargets maps login-proxy kinds to upstream hosts. Package
// level so tests can point them at local fakes.
var authProxyTargets = map[string]string{
	"accounts": "https://accounts.pixiv.net",
	"app":      "https://app-api.pixiv.net",
	"www":      "https://www.pixiv.net",
	"oauth":    "https://oauth.secure.pixiv.net",
}

const loginFlowCookie = "pixtok_login"

var browserUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"

// rewriteCookie rebuilds a Set-Cookie header without Domain=/Secure=/
// Expires=/Max-Age=/SameSite. Host-only cookies on our origin are the
// whole trick: the browser stores and replays them on follow-up
// requests through the proxy, so the backend can read pixiv's session.
// `secure` is secureForRequest(r): on HTTPS transports the Secure
// attribute is preserved (reviewer finding: stripping it unconditionally
// let session cookies ride plaintext on the public tunnel); on HTTP
// transports it must go, or the browser stores but never sends the
// cookie and the session silently breaks.
func rewriteCookie(setCookie string, secure bool) string {
	parts := strings.Split(setCookie, ";")
	out := make([]string, 0, 3)
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t == "" {
			continue
		}
		lower := strings.ToLower(t)
		if strings.HasPrefix(lower, "domain=") ||
			(lower == "secure" && !secure) ||
			strings.HasPrefix(lower, "expires=") ||
			strings.HasPrefix(lower, "max-age=") ||
			strings.HasPrefix(lower, "samesite=") {
			continue
		}
		out = append(out, t)
	}
	if len(out) == 0 {
		return ""
	}
	return strings.Join(out, "; ")
}

// rewriteLocation maps an upstream redirect back onto our proxy paths so
// the browser never leaves the app origin during the flow.
//
// Security invariant (reviewer finding): matching must be EXACT — parsed
// scheme + hostname + port equality. Prefix matching would also rewrite
// https://accounts.pixiv.net.evil.example/... (suffix-domain confusion).
// Only Pixiv-owned hosts may ever be mapped onto our proxy paths.
func rewriteLocation(loc string) string {
	u, err := url.Parse(loc)
	if err != nil || u.Hostname() == "" {
		return loc // relative or malformed — leave for the browser to resolve
	}
	// Scheme-relative URLs (//host/...) parse with an empty scheme —
	// resolved against the target's scheme below. Anything else must
	// match the target's scheme exactly.
	for kind, target := range authProxyTargets {
		t, err := url.Parse(target)
		if err != nil {
			continue
		}
		if u.Scheme == "" {
			u.Scheme = t.Scheme
		}
		if u.Scheme != t.Scheme || u.Hostname() != t.Hostname() {
			continue
		}
		// Port: empty (scheme default) or the target's own explicit
		// port. This rejects https://accounts.pixiv.net:8443/... while
		// still allowing test fakes on random local ports.
		defaultPort := "443"
		if u.Scheme == "http" {
			defaultPort = "80"
		}
		if p := u.Port(); p != "" && p != defaultPort && p != t.Port() {
			continue
		}
		rest := u.EscapedPath()
		if u.RawQuery != "" {
			rest += "?" + u.RawQuery
		}
		if u.Fragment != "" {
			rest += "#" + u.Fragment
		}
		return "/api/auth/px/" + kind + rest
	}
	// NOT a pixiv host: pass through unchanged (reviewer note). The
	// login flow can emit foreign absolute URLs (analytics, CDN
	// scripts) — they must never be rewritten onto OUR origin, and the
	// proxied page may legitimately reference them. Deliberate
	// allow-through: the browser follows them off-origin; nothing is
	// proxied.
	return loc
}

// isCORSHeader reports whether a response header belongs to CORS
// (Access-Control-Allow-Origin etc.) — upstream CORS posture must never
// leak onto our origin (reviewer finding).
func isCORSHeader(k string) bool {
	switch k {
	case "Access-Control-Allow-Origin", "Access-Control-Allow-Credentials",
		"Access-Control-Allow-Headers", "Access-Control-Allow-Methods",
		"Access-Control-Expose-Headers", "Access-Control-Max-Age":
		return true
	}
	return false
}

// rewriteBodyURLs maps absolute pixiv URLs inside JSON response bodies
// back onto our proxy paths. The login SPA replies with absolute URLs
// (success.returnTo, 2FA redirects) — without this the browser would
// leave our origin mid-flow and drop the rewritten cookies.
func rewriteBodyURLs(body []byte) []byte {
	for kind, target := range authProxyTargets {
		prefix := []byte("/api/auth/px/" + kind)
		// PHP json_encode escapes "/" as "\/" — pixiv's responses carry
		// URLs in BOTH forms, so rewrite each of them (and the
		// protocol-relative variants). Missing the escaped form leaves
		// returnTo absolute → the browser hops straight to real pixiv
		// and the flow dies with a login-page reload.
		//
		// Security invariant (reviewer finding): a replacement only
		// counts when the byte AFTER the hostname is a URL boundary
		// (" / ? # ...) — never '.', or suffix-domain lookalikes like
		// https://accounts.pixiv.net.evil.example would also be
		// rewritten onto our proxy path.
		for _, form := range []string{
			target, // https://host
			"//" + strings.TrimPrefix(target, "https://"), // //host
			strings.ReplaceAll(target, "/", `\/`),         // https:\/\/host
			strings.ReplaceAll("//"+strings.TrimPrefix(target, "https://"), "/", `\/`),
		} {
			body = replaceURLBoundary(body, []byte(form), prefix)
		}
		// NOTE: percent-encoded forms are deliberately NOT rewritten.
		// Pixiv nests URLs inside query strings (post-redirect's
		// return_to) and VALIDATES the host server-side — a rewritten
		// relative path fails their open-redirect guard ("something
		// went wrong"). The real URL passes validation and the page
		// answers with a 302 whose Location header our header rewrite
		// maps back onto the proxy.
	}
	return body
}

// replaceURLBoundary replaces needle with repl wherever the byte AFTER
// the match is a URL-boundary byte (or the match ends the body).
func replaceURLBoundary(body, needle, repl []byte) []byte {
	if len(needle) == 0 {
		return body
	}
	var out []byte
	rest := body
	for {
		i := bytes.Index(rest, needle)
		if i < 0 {
			out = append(out, rest...)
			return out
		}
		end := i + len(needle)
		if end < len(rest) && !isURLBoundary(rest[end]) {
			// Not a boundary — e.g. "accounts.pixiv.net.evil" — keep the
			// text verbatim and resume scanning after it.
			out = append(out, rest[:end]...)
			rest = rest[end:]
			continue
		}
		out = append(out, rest[:i]...)
		out = append(out, repl...)
		rest = rest[end:]
	}
}

func isURLBoundary(b byte) bool {
	switch b {
	case '/', '?', '#', '"', '\'', '\\', ',', '}', ']', ' ', '	', '\n', '\r', '&', '=':
		return true
	}
	return false
}

// registerAuthProxy wires the proxied-login routes. /api/auth/px/* is
// hit by browser NAVIGATIONS during the login flow — gated by the
// login-flow cookie set at /api/auth/pkce/start (only someone who
// started a flow through the key-gated start route gets proxy access;
// and the flow cookie expires in 10 minutes).
func registerAuthProxy(mux *http.ServeMux, api pixivAPI, pkce *pkceStore) {
	// CRITICAL: never follow redirects server-side. Each upstream
	// response (including 302s) must go back to the BROWSER so it
	// follows the REWRITTEN Location through the proxy again — that's
	// what keeps the whole login chain (and the cookie rewriting) on
	// our origin. With default redirect-following the client would hop
	// to real pixiv hosts directly, bypassing every rewrite.
	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	// serveProxy forwards one request to the given upstream kind, applies
	// the cookie/Location rewrites, and rewrites absolute pixiv URLs inside
	// JSON response bodies (the login SPA replies with absolute returnTo /
	// 2FA URLs — the browser must follow them back through this proxy).
	serveProxy := func(kind, rest string, w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(loginFlowCookie)
		if err != nil || c.Value == "" {
			http.Error(w, "login flow not started", http.StatusForbidden)
			return
		}

		// Method allowlist (reviewer finding): a login proxy has no
		// business forwarding anything but the browser's own
		// navigation/form methods. PUT/PATCH/DELETE/CONNECT/TRACE must
		// never reach pixiv through us.
		switch r.Method {
		case http.MethodGet, http.MethodPost, http.MethodHead:
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// The PKCE callback: OUR one-time code arrives home. Exchange
		// it, capture the web session, and land the user back in the
		// app — no console tricks, no pasting, no Mac.
		if kind == "app" && strings.Contains(r.URL.Path, "/users/auth/pixiv/callback") {
			handlePkceCallback(w, r, api, pkce)
			return
		}

		if rest == "" {
			rest = "/"
		}
		// Cap proxied request bodies — a flow-cookie holder should not be
		// able to stream unbounded data through us into Pixiv.
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		req, err := http.NewRequest(r.Method, authProxyTargets[kind]+rest, r.Body)
		if err != nil {
			http.Error(w, "proxy build failed", http.StatusBadGateway)
			return
		}
		// Accept-Encoding deliberately dropped: we rewrite JSON bodies
		// below, which is impossible on gzip/br-compressed responses.
		for _, h := range []string{"Accept", "Accept-Language", "Content-Type", "Content-Length", "Referer", "Origin", "X-Requested-With"} {
			if v := r.Header.Get(h); v != "" {
				req.Header.Set(h, v)
			}
		}
		// Forward only PIXIV'S cookies upstream (reviewer finding: the
		// old filter was "everything not pixtok_*", a blacklist — any
		// third-party cookie our origin ever holds would leak to
		// pixiv). Allowlist the cookies the login flow actually needs:
		// PHPSESSID (the session) + device_token; pixiv's other cookies
		// are analytics, not auth.
		if ck := r.Header.Get("Cookie"); ck != "" {
			var kept []string
			for _, part := range strings.Split(ck, ";") {
				name := strings.TrimSpace(strings.SplitN(part, "=", 2)[0])
				switch name {
				case "PHPSESSID", "device_token":
					kept = append(kept, strings.TrimSpace(part))
				}
			}
			if len(kept) > 0 {
				req.Header.Set("Cookie", strings.Join(kept, "; "))
			}
		}
		req.Header.Set("User-Agent", browserUA)

		resp, err := client.Do(req)
		if err != nil {
			log.Printf("ERROR login proxy: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		// The critical rewrite.
		cookies := resp.Header.Values("Set-Cookie")
		resp.Header.Del("Set-Cookie")
		for _, sc := range cookies {
			if rewritten := rewriteCookie(sc, secureForRequest(r)); rewritten != "" {
				resp.Header.Add("Set-Cookie", rewritten)
			}
		}
		if loc := resp.Header.Get("Location"); loc != "" {
			resp.Header.Set("Location", rewriteLocation(loc))
		}

		for k, vs := range resp.Header {
			// Content-Length and Content-Encoding must not be copied
			// verbatim: bodies are truncated (2-8 MB) and rewritten below,
			// so an upstream Content-Length would desync the response. The
			// rewrite branch sets its own; the passthrough streams chunked.
			// Access-Control-* is the UPSTREAM's CORS posture — copying it
			// onto our origin is needless and could confuse browsers
			// (reviewer finding). The login SPA is same-origin through
			// this proxy and needs no CORS grants.
			if k == "Content-Length" || k == "Content-Encoding" || isCORSHeader(k) {
				continue
			}
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		// Every proxy response is transient login-flow state (pages,
		// redirects, tokens). Never let it be cached by the browser or
		// an intermediary (reviewer finding).
		w.Header().Set("Cache-Control", "no-store")

		// JSON bodies: rewrite absolute pixiv URLs onto our proxy paths.
		// Also rewrite HTML on the post-redirect bouncer: if that page
		// navigates via meta-refresh/JS instead of a 302, the embedded
		// URL must stay on our origin too.
		ct := resp.Header.Get("Content-Type")
		rewriteBody := strings.Contains(ct, "json") ||
			(kind == "accounts" && strings.Contains(r.URL.Path, "/post-redirect") && strings.Contains(ct, "html"))
		if rewriteBody {
			body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
			if err == nil {
				body = rewriteBodyURLs(body)
				w.Header().Set("Content-Length", strconv.Itoa(len(body)))
				w.WriteHeader(resp.StatusCode)
				_, _ = w.Write(body)
				return
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, io.LimitReader(resp.Body, 8<<20))
	}

	// px routes: the login flow's navigations (/api/auth/px/<kind>/...).
	proxy := func(kind string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			rest := strings.TrimPrefix(r.URL.RequestURI(), "/api/auth/px/"+kind)
			serveProxy(kind, rest, w, r)
		}
	}

	mux.HandleFunc("/api/auth/px/accounts/", proxy("accounts"))
	mux.HandleFunc("/api/auth/px/app/", proxy("app"))
	mux.HandleFunc("/api/auth/px/www/", proxy("www"))
	mux.HandleFunc("/api/auth/px/oauth/", proxy("oauth"))

	// The login SPA's XHRs are root-relative (/ajax/login, /ajax/login/
	// two-factor-authentication/...) — from OUR origin they arrive here
	// and belong to accounts.pixiv.net. Flow-cookie gated like the px
	// routes (10-minute window, only set by pkce/start). The post-login
	// "continue using account" interstitial POSTs /account-selected the
	// same way (found live Aug 24) — BUT the endpoint lives on www, not
	// accounts (accounts 404s it; www 302-chains it toward the OAuth
	// continuation). Both slash variants registered: the upstream
	// redirects /account-selected → /account-selected/. Pixiv's OAuth
	// continuation also lands on root-relative /web/v1/users/auth/pixiv/
	// paths (found live Aug 25: after "continue", the browser is sent to
	// /web/v1/... which belongs on app-api.pixiv.net) — proxied here too,
	// with the callback intercepted by the app-route handler below.
	mux.HandleFunc("/ajax/", func(w http.ResponseWriter, r *http.Request) {
		serveProxy("accounts", r.URL.RequestURI(), w, r)
	})
	mux.HandleFunc("/account-selected", func(w http.ResponseWriter, r *http.Request) {
		serveProxy("www", r.URL.RequestURI(), w, r)
	})
	mux.HandleFunc("/account-selected/", func(w http.ResponseWriter, r *http.Request) {
		serveProxy("www", r.URL.RequestURI(), w, r)
	})
	mux.HandleFunc("/web/v1/login", func(w http.ResponseWriter, r *http.Request) {
		serveProxy("app", r.URL.RequestURI(), w, r)
	})
	mux.HandleFunc("/web/v1/login/", func(w http.ResponseWriter, r *http.Request) {
		serveProxy("app", r.URL.RequestURI(), w, r)
	})
	mux.HandleFunc("/web/v1/users/auth/pixiv/start", func(w http.ResponseWriter, r *http.Request) {
		serveProxy("app", r.URL.RequestURI(), w, r)
	})
	mux.HandleFunc("/web/v1/users/auth/pixiv/start/", func(w http.ResponseWriter, r *http.Request) {
		serveProxy("app", r.URL.RequestURI(), w, r)
	})

	// GET /api/auth/pkce/start — the FE Sign-in button navigates here.
	// Key-gated (Vite injects the header on navigations too). Issues the
	// challenge, drops the login-flow cookie, and bounces into the
	// proxied pixiv OAuth login.
	mux.HandleFunc("/api/auth/pkce/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		verifier, err := randomB64(32)
		if err != nil {
			http.Error(w, "rng failure", http.StatusInternalServerError)
			return
		}
		sum := sha256.Sum256([]byte(verifier))
		challenge := base64.RawURLEncoding.EncodeToString(sum[:])
		// The flow token keys the verifier in the pkce store AND is the
		// login-flow cookie value. It rides the whole browser chain
		// (Path=/), so the callback can look the verifier up without a
		// state round-trip — pixiv generates its OWN state for the
		// callback and ours never comes back.
		flowID, err := randomB64(16)
		if err != nil {
			http.Error(w, "rng failure", http.StatusInternalServerError)
			return
		}
		pkce.put(flowID, verifier)

		http.SetCookie(w, &http.Cookie{
			Name:     loginFlowCookie,
			Value:    flowID,
			Path:     "/",
			MaxAge:   10 * 60,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			// Match the transport's Secure posture like every other
			// cookie this backend sets (review finding): kept on HTTPS
			// transports, dropped on plaintext so the flow still works
			// over direct tailnet/localhost HTTP.
			Secure: secureForRequest(r),
		})
		http.Redirect(w, r,
			"/api/auth/px/app/web/v1/login?code_challenge="+challenge+
				"&code_challenge_method=S256&client=pixiv-android",
			http.StatusFound)
	})
}

// handlePkceCallback completes the flow server-side: exchange the code,
// persist the permanent refresh token, capture PHPSESSID off the
// request's cookie jar (it lives on our origin now), scrape + persist
// the bound csrf token, and land the user back in the app.
func handlePkceCallback(w http.ResponseWriter, r *http.Request, api pixivAPI, pkce *pkceStore) {
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}
	// The URL's state param is PIXIV's own (generated inside their
	// flow) — it never matched anything we stored. The verifier is
	// keyed by the login-flow cookie instead, which rides the whole
	// chain on our origin.
	flowCookie, err := r.Cookie(loginFlowCookie)
	if err != nil || flowCookie.Value == "" {
		http.Error(w, "login flow not started", http.StatusForbidden)
		return
	}
	verifier, ok := pkce.take(flowCookie.Value)
	if !ok {
		log.Printf("WARN pkce callback: unknown or expired flow")
		http.Error(w, "unknown or expired login flow — start again", http.StatusBadRequest)
		return
	}
	refreshTok, accessTok, expiresIn, err := api.ExchangePkce(code, verifier)
	if err != nil {
		log.Printf("ERROR pkce exchange: %v", err)
		http.Error(w, "pkce exchange failed", http.StatusBadGateway)
		return
	}
	// Persistence is part of authentication (reviewer finding): a
	// "success" that only lives in memory dies on the next restart.
	// Fail the callback instead of pretending the login is durable.
	if err := api.SetTokens(refreshTok, accessTok, expiresIn); err != nil {
		log.Printf("ERROR persisting tokens: %v", err)
		http.Error(w, "login succeeded but could not be persisted — retry", http.StatusInternalServerError)
		return
	}

	// Web-session capture from the cookie jar the login just populated.
	if c, err := r.Cookie("PHPSESSID"); err == nil && c.Value != "" {
		csrf, err := api.ScrapeCsrfFor(c.Value)
		if err != nil {
			log.Printf("ERROR csrf scrape after login: %v", err)
		} else if err := api.SetWebSession(c.Value, csrf); err != nil {
			log.Printf("ERROR persisting session: %v", err)
		}
	} else {
		log.Printf("WARN no PHPSESSID on callback — web session not captured")
	}

	// The session is now captured server-side — expire every cookie the
	// login flow planted on OUR origin that isn't ours (pixiv's
	// PHPSESSID, device_token, analytics). The browser must not keep a
	// live Pixiv credential it no longer needs. pixtok_* cookies (gate,
	// login flow) survive. Symmetric with the upstream forwarding
	// allowlist above: only pixtok_* + pixiv cookies ever exist here.
	for _, c := range r.Cookies() {
		if strings.HasPrefix(c.Name, "pixtok_") {
			continue
		}
		http.SetCookie(w, &http.Cookie{
			Name:   c.Name,
			Value:  "",
			Path:   "/",
			MaxAge: -1,
			// Match the transport's Secure posture like every other
			// cookie this proxy sets (reviewer finding: the deletion
			// cookies were always plain).
			Secure: secureForRequest(r),
		})
	}

	http.Redirect(w, r, "/?auth=done", http.StatusFound)
}
