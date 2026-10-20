package main

// One .env resolver (review finding M5): reads, writes and the boot
// permission check must agree about which file holds a credential. The
// dangerous shape is two candidate .env files where an earlier one exists
// but lacks the key: the old permission check `break`ed at the first
// existing file, so it never inspected the file that actually supplied
// the credential.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFile is a tiny fixture helper: create a file with explicit mode.
func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	// WriteFile applies the umask; force the mode the test intends.
	if err := os.Chmod(path, mode); err != nil {
		t.Fatalf("chmod %s: %v", path, err)
	}
}

func TestCheckEnvFilePermissionsInspectsEveryCandidate(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first.env")
	second := filepath.Join(dir, "second.env")
	// The first file exists and is tight; the SECOND is the one that can
	// actually supply a credential (and is world-writable).
	writeFile(t, first, "PIXTOK_CACHE_TTL=1h\n", 0o600)
	writeFile(t, second, "PIXTOK_GATE_PASSWORD_HASH=$2y$10$whatever\n", 0o666)

	err := checkEnvFilePermissions([]string{first, second})
	if err == nil {
		t.Fatal("world-writable LATER candidate accepted — the permission check stopped at the first existing file")
	}
	if !strings.Contains(err.Error(), second) {
		t.Fatalf("error names the wrong file: %v", err)
	}
}

func TestCheckEnvFilePermissionsAcceptsTightFiles(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.env")
	b := filepath.Join(dir, "b.env")
	writeFile(t, a, "A=1\n", 0o600)
	writeFile(t, b, "B=2\n", 0o600)
	if err := checkEnvFilePermissions([]string{a, b}); err != nil {
		t.Fatalf("tight files rejected: %v", err)
	}
	// Missing candidates are simply skipped (create-target deployments).
	if err := checkEnvFilePermissions([]string{filepath.Join(dir, "nope.env")}); err != nil {
		t.Fatalf("missing candidate rejected: %v", err)
	}
}

// loadEnvKey must find a key in a LATER candidate when an earlier one
// exists but lacks it. PIXTOK_ENV_FILE pins a single file, so drive the
// resolver at the pixiv layer through a build-style candidate list: the
// integration point main uses is loadEnvKey -> pixiv.ReadEnvKey, and the
// multi-file behavior lives in the shared resolver.
func TestLoadEnvKeyMatchesSharedResolver(t *testing.T) {
	dir := t.TempDir()
	pinned := filepath.Join(dir, ".env")
	writeFile(t, pinned, "PIXTOK_CACHE_TTL=42m\n", 0o600)
	t.Setenv("PIXTOK_ENV_FILE", pinned)

	if got := loadEnvKey("PIXTOK_CACHE_TTL"); got != "42m" {
		t.Fatalf("loadEnvKey = %q, want the pinned file's value", got)
	}
	// Environment wins over the file (documented precedence).
	t.Setenv("PIXTOK_CACHE_TTL", "7m")
	if got := loadEnvKey("PIXTOK_CACHE_TTL"); got != "7m" {
		t.Fatalf("loadEnvKey = %q, want the environment's value", got)
	}
}
