package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
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
