package main

// Public-HTTPS posture caching (review finding M7, the half that is
// correct to fix). securityHeaders calls secureForRequest on EVERY
// response — assets and images included — and the old implementation
// re-read .env (os.Executable + os.ReadFile) per response, with a
// transient read failure silently dropping Secure. The posture is boot
// config now: resolved once, cached, with a test hook.
//
// Deliberately NOT fixed here: there is no boot requirement for
// PIXTOK_PUBLIC_HTTPS. Per-request Secure (TLS or X-Forwarded-Proto)
// stays exactly as it is — that behavior was a live fix.

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPublicHTTPSPostureIsCachedAfterFirstResolution(t *testing.T) {
	withPublicHTTPS(t, "true")
	if !publicHTTPSEnabled() {
		t.Fatal("posture = false with PIXTOK_PUBLIC_HTTPS=true")
	}

	// Flipping the environment must NOT change the answer: the value is a
	// boot-time read, not a per-request one. (Before the fix this call
	// re-read the environment and returned false.)
	t.Setenv("PIXTOK_PUBLIC_HTTPS", "false")
	if !publicHTTPSEnabled() {
		t.Fatal("posture changed mid-process — the .env/env read is still per request")
	}

	// The test hook re-resolves.
	resetPublicHTTPSCache()
	if publicHTTPSEnabled() {
		t.Fatal("resetPublicHTTPSCache did not re-read the posture")
	}
}

// secureForRequest must keep deciding the per-request half (TLS /
// X-Forwarded-Proto) live — only the deployment flag is cached.
func TestSecureForRequestStillPerRequest(t *testing.T) {
	withPublicHTTPS(t, "true")

	plain := httptest.NewRequest(http.MethodGet, "/", nil)
	if secureForRequest(plain) {
		t.Fatal("plain HTTP request got Secure")
	}
	fwd := httptest.NewRequest(http.MethodGet, "/", nil)
	fwd.Header.Set("X-Forwarded-Proto", "https")
	if !secureForRequest(fwd) {
		t.Fatal("X-Forwarded-Proto: https request lost Secure")
	}
	tlsReq := httptest.NewRequest(http.MethodGet, "/", nil)
	tlsReq.TLS = &tls.ConnectionState{}
	if !secureForRequest(tlsReq) {
		t.Fatal("direct TLS request lost Secure")
	}
}
