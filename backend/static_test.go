package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testStaticFS() (fstest.MapFS, []byte) {
	return fstest.MapFS{
		"index.html":         &fstest.MapFile{Data: []byte("<!doctype html><html>pixtok app shell</html>")},
		"assets/app-a1b2.js": &fstest.MapFile{Data: []byte("console.log('pixtok')")},
	}, []byte("<!doctype html><html>pixtok app shell</html>")
}

func TestStaticServesIndexAtRoot(t *testing.T) {
	fsys, idx := testStaticFS()
	h := staticHandlerFrom(fsys, idx)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr.Code != http.StatusOK || rr.Body.String() != string(idx) {
		t.Fatalf("root = %d %q, want 200 index", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("content-type = %q", ct)
	}
	if cc := rr.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("index cache-control = %q, want no-cache", cc)
	}
}

func TestStaticSPAFallback(t *testing.T) {
	fsys, idx := testStaticFS()
	h := staticHandlerFrom(fsys, idx)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/some/client/only/route", nil))
	if rr.Code != http.StatusOK || rr.Body.String() != string(idx) {
		t.Fatalf("deep route = %d, want 200 with the app shell (SPA fallback)", rr.Code)
	}
}

func TestStaticAssetsImmutable(t *testing.T) {
	fsys, idx := testStaticFS()
	h := staticHandlerFrom(fsys, idx)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/assets/app-a1b2.js", nil))
	if rr.Code != http.StatusOK || rr.Body.String() != "console.log('pixtok')" {
		t.Fatalf("asset = %d %q, want 200 with content", rr.Code, rr.Body.String())
	}
	if cc := rr.Header().Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
		t.Fatalf("asset cache-control = %q", cc)
	}
}

func TestStaticMissingAssetIs404(t *testing.T) {
	fsys, idx := testStaticFS()
	h := staticHandlerFrom(fsys, idx)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/assets/nope.js", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("missing asset = %d, want 404 (no SPA fallback for /assets/)", rr.Code)
	}
}

func TestStaticWithoutBuildIs503(t *testing.T) {
	fsys, _ := testStaticFS()
	h := staticHandlerFrom(fsys, nil) // embedded index.html missing
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("unbuilt frontend = %d, want 503", rr.Code)
	}
}

func TestValidateProdServeFailClosed(t *testing.T) {
	if err := validateProdServe(true, false); err == nil {
		t.Fatal("frontend serving with the gate disabled must refuse to boot")
	}
	if err := validateProdServe(true, true); err != nil {
		t.Fatalf("frontend serving with the gate enabled = %v, want nil", err)
	}
	if err := validateProdServe(false, false); err != nil {
		t.Fatalf("dev mode (no frontend serving) without gate = %v, want nil", err)
	}
}

// The prod-mode chain (main()'s serveFrontend wiring) exercised in CI
// without touching pixiv: static SPA serves unauthenticated, everything
// under /api is gated, and a real unlock opens it. The prod-serve e2e
// spec was removed from CI because it needed a live pixiv token — this
// pins the same chain with a fake API instead.
func TestProdServeChainStaticAndGate(t *testing.T) {
	g, err := newGate("ci-test-password", true)
	if err != nil {
		t.Fatalf("newGate: %v", err)
	}
	fsys := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>pixtok</html>")},
	}
	inner := newServerBase(&fakeAPI{}, newImageCache(time.Hour, 10, 512<<20))
	registerGateRoutes(inner, g)

	root := http.NewServeMux()
	root.Handle("/api/", g.middleware(inner))
	root.Handle("/ajax/", g.middleware(inner))
	root.Handle("/health", g.middleware(inner))
	root.Handle("/", staticHandlerFrom(fsys, []byte("<html>pixtok</html>")))

	// Static serves without any cookie.
	rr := httptest.NewRecorder()
	root.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/", nil))
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "pixtok") {
		t.Fatalf("static = %d %q, want 200 app shell", rr.Code, rr.Body.String())
	}

	// API is locked without the cookie.
	rr = httptest.NewRecorder()
	root.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/gate/status", nil))
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"locked":true`) {
		t.Fatalf("status without cookie = %d %q, want locked:true", rr.Code, rr.Body.String())
	}
	rr = httptest.NewRecorder()
	root.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/top", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("gated feed without cookie = %d, want 403", rr.Code)
	}

	// A real unlock sets the cookie; the same cookie opens the API.
	req := httptest.NewRequest(http.MethodPost, "/api/gate",
		strings.NewReader(`{"password":"ci-test-password"}`))
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	root.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("unlock = %d (body: %s)", rr.Code, rr.Body.String())
	}
	var gateC *http.Cookie
	for _, c := range rr.Result().Cookies() {
		if c.Name == gateCookie {
			gateC = c
		}
	}
	if gateC == nil {
		t.Fatal("unlock response did not set the gate cookie")
	}

	req = httptest.NewRequest(http.MethodGet, "/api/gate/status", nil)
	req.AddCookie(gateC)
	rr = httptest.NewRecorder()
	root.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"locked":false`) {
		t.Fatalf("status with cookie = %d %q, want unlocked", rr.Code, rr.Body.String())
	}
}
