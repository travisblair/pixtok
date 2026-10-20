package main

// Loopback-only listener posture (review finding L2). SECURITY.md lists
// "loopback-only backend" as a LAN mitigation, but PIXTOK_LISTEN was
// passed straight to http.Server.Addr — `:3001` or `0.0.0.0:3001` put a
// plaintext-HTTP app on every interface with no check at all.

import (
	"strings"
	"testing"
)

func TestValidateListenAddr(t *testing.T) {
	cases := []struct {
		name        string
		addr        string
		allowPublic bool
		wantLoop    bool
		wantErr     string // substring
	}{
		{"default loopback v4", "127.0.0.1:8080", false, true, ""},
		{"loopback v6", "[::1]:8080", false, true, ""},
		{"localhost name", "localhost:8080", false, true, ""},
		{"all interfaces refused", ":3001", false, false, "non-loopback"},
		{"wildcard v4 refused", "0.0.0.0:3001", false, false, "non-loopback"},
		{"lan address refused", "192.168.1.5:3001", false, false, "non-loopback"},
		{"wildcard with override", "0.0.0.0:3001", true, false, ""},
		{"all interfaces with override", ":3001", true, false, ""},
		{"malformed refused", "not-an-addr", false, false, "not host:port"},
		{"port only refused", "8080", false, false, "not host:port"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			loop, err := validateListenAddr(tc.addr, tc.allowPublic)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("validateListenAddr(%q, %v) = %v, want nil", tc.addr, tc.allowPublic, err)
				}
			} else {
				if err == nil {
					t.Fatalf("validateListenAddr(%q, %v) accepted, want error containing %q", tc.addr, tc.allowPublic, tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error = %v, want it to mention %q", err, tc.wantErr)
				}
			}
			if loop != tc.wantLoop {
				t.Fatalf("loopback = %v, want %v", loop, tc.wantLoop)
			}
		})
	}
}
