package main

import (
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// originCheckPathsExempt skip the same-host check entirely: the proxied
// pixiv login (/ajax/*, /api/auth/*) and Cloudflare's challenge platform
// (/cdn-cgi/*, served through the proxied pages) legitimately issue
// POSTs whose Origin will never satisfy a same-host rule (opaque/null
// origins from challenge frames, pixiv's own SPA machinery). These
// surfaces are already gated by the login-flow cookie and were already
// CSP-exempt for the same reason. Everything else keeps the check —
// mutations outside the login flow stay protected.
func originCheckPathExempt(path string) bool {
	return strings.HasPrefix(path, "/ajax/") ||
		strings.HasPrefix(path, "/api/auth/") ||
		strings.HasPrefix(path, "/cdn-cgi/")
}

// originCheck rejects cross-origin state-changing requests. Browsers
// attach an Origin header to cross-origin POSTs (and, via fetch, to
// same-origin ones too). When present on a mutating method, its hostname
// must match the request Host's hostname. Non-browser clients (curl, API
// tools) send no Origin and pass through — CSRF is a browser-only
// attack. GET/HEAD are read-only and exempt, as are OPTIONS preflights
// (they carry no state; the mutating request that follows is still
// checked).
//
// HOSTNAME, not host:port (found live, Aug 2026): the Origin header and
// the Host header carry different ports across legitimate deployment
// topologies — the Vite dev proxy rewrites Host to :8080 while Origin
// says :5173, and serve/Funnel terminate on their own ports. The port
// carries no origin-security signal here; the property that matters is
// "same host". Authentication (gate cookie / API key) is the real
// boundary — this check is defense-in-depth.
//
// Rejections are LOGGED with method/path/Origin/Host (found live Aug 24:
// originCheck wrapped OUTSIDE logRequests, so its 403s produced no REQ
// line and a broken login flow left zero trace in the journal).
func originCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !originCheckPathExempt(r.URL.Path) {
			u, err := url.Parse(origin)
			hostMatch := err == nil && strings.EqualFold(u.Hostname(), hostnameOf(r.Host))
			if !hostMatch {
				log.Printf("WARN origin rejected: %s %s origin=%q host=%q",
					r.Method, r.URL.Path, origin, r.Host)
				http.Error(w, "cross-origin request rejected", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// hostnameOf strips the port from a host:port string (or returns it
// unchanged when no port is present).
func hostnameOf(hostPort string) string {
	if h, _, err := net.SplitHostPort(hostPort); err == nil {
		return h
	}
	return hostPort
}
