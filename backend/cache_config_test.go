package main

import (
	"path/filepath"
	"testing"
	"time"
)

func TestCacheConfigDefaults(t *testing.T) {
	// Unset → Pi-safe defaults: the image cache must fit the Pi Zero W's
	// 512MB RAM out of the box (a deploy that forgets its .env overrides
	// must not starve itself). Bigger machines opt UP via env. The env
	// file pin defeats any real .env lookup in this environment.
	t.Setenv("PIXTOK_ENV_FILE", filepath.Join(t.TempDir(), "missing.env"))
	t.Setenv("PIXTOK_CACHE_TTL", "")
	t.Setenv("PIXTOK_CACHE_ENTRIES", "")
	t.Setenv("PIXTOK_CACHE_BYTES", "")

	ttl, entries, maxBytes := cacheConfigFromEnv()
	if ttl != 6*time.Hour || entries != 300 || maxBytes != 64<<20 {
		t.Fatalf("defaults = %v / %d / %d, want 6h / 300 / 64MB", ttl, entries, maxBytes)
	}
}

func TestCacheConfigParsesEnvSizing(t *testing.T) {
	t.Setenv("PIXTOK_ENV_FILE", filepath.Join(t.TempDir(), "missing.env"))
	t.Setenv("PIXTOK_CACHE_TTL", "12h")
	t.Setenv("PIXTOK_CACHE_ENTRIES", "1000")
	t.Setenv("PIXTOK_CACHE_BYTES", "134217728")

	ttl, entries, maxBytes := cacheConfigFromEnv()
	if ttl != 12*time.Hour || entries != 1000 || maxBytes != 128<<20 {
		t.Fatalf("env sizing = %v / %d / %d, want 12h / 1000 / 128MB", ttl, entries, maxBytes)
	}
}

func TestCacheConfigGarbageFallsBack(t *testing.T) {
	// A misconfigured cache must never block boot — each bad value falls
	// back to its default while the good ones still apply.
	t.Setenv("PIXTOK_ENV_FILE", filepath.Join(t.TempDir(), "missing.env"))
	t.Setenv("PIXTOK_CACHE_TTL", "not-a-duration")
	t.Setenv("PIXTOK_CACHE_ENTRIES", "-5")
	t.Setenv("PIXTOK_CACHE_BYTES", "lots")

	ttl, entries, maxBytes := cacheConfigFromEnv()
	if ttl != 6*time.Hour || entries != 300 || maxBytes != 64<<20 {
		t.Fatalf("garbage = %v / %d / %d, want defaults", ttl, entries, maxBytes)
	}
}
