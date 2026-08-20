package main

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

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
// Defense-in-depth on top of the existing controls: mutations are
// POST-only with validated IDs, the gate unlock requires a JSON
// content-type (which forces cross-origin form posts into a preflight),
// and the gate cookie is SameSite=Lax (never sent on cross-site POSTs).
func originCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !strings.EqualFold(u.Hostname(), hostnameOf(r.Host)) {
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
