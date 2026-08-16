package main

import (
	"net/http"
	"net/url"
	"strings"
)

// originCheck rejects cross-origin state-changing requests. Browsers
// attach an Origin header to cross-origin POSTs (and, via fetch, to
// same-origin ones too). When present on a mutating method, its host must
// match the request Host. Non-browser clients (curl, API tools) send no
// Origin and pass through — CSRF is a browser-only attack. GET/HEAD are
// read-only and exempt, as are OPTIONS preflights (they carry no state;
// the mutating request that follows is still checked).
//
// This is defense-in-depth on top of the existing controls: mutations are
// POST-only with validated IDs, the gate unlock requires a JSON
// content-type (which forces cross-origin form posts into a preflight),
// and the gate cookie is SameSite=Lax.
func originCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !strings.EqualFold(u.Host, r.Host) {
				http.Error(w, "cross-origin request rejected", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
