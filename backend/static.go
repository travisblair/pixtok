package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
)

// The built frontend (vite build → backend/static) is embedded into the
// binary so the production server is a single file. The committed
// static/.gitkeep lets go:embed compile on a clean checkout with no
// assets yet — the handler then answers 503 "frontend not built" instead
// of 404ing silently.
//
//go:embed all:static
var staticFS embed.FS

// staticHandlerFrom serves a built SPA from any fs.FS (the embedded
// static dir in prod, fstest.MapFS in tests). indexHTML is read once;
// hashed assets stream via http.FileServerFS.
func staticHandlerFrom(fsys fs.FS, indexHTML []byte) http.Handler {
	files := http.FileServerFS(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/assets/") {
			if _, err := fs.Stat(fsys, strings.TrimPrefix(p, "/")); err != nil {
				http.NotFound(w, r)
				return
			}
			// Vite hashes asset filenames — safe to cache forever.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			files.ServeHTTP(w, r)
			return
		}
		if len(indexHTML) == 0 {
			http.Error(w, "frontend not built (run: npm run build)", http.StatusServiceUnavailable)
			return
		}
		// Everything else is the SPA: / and any client-side path.
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(indexHTML)
	})
}

// validateProdServe enforces the fail-closed invariant of
// PIXTOK_SERVE_FRONTEND: serving the app while the gate is disabled
// would expose the whole thing unauthenticated. A deployment mistake
// must refuse to boot, not silently degrade.
func validateProdServe(serveFrontend, gateEnabled bool) error {
	if serveFrontend && !gateEnabled {
		return fmt.Errorf("PIXTOK_SERVE_FRONTEND requires an enabled password gate (set PIXTOK_GATE_PASSWORD_HASH)")
	}
	return nil
}

// staticHandler wires the embedded frontend build.
func staticHandler() http.Handler {
	sub, _ := fs.Sub(staticFS, "static")
	idx, _ := staticFS.ReadFile("static/index.html")
	return staticHandlerFrom(sub, idx)
}
