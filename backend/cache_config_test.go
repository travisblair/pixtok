package main

import (
	"testing"
	"time"
)

func TestCacheConfigDefaults(t *testing.T) {
	// Unset → Mac-sized defaults (the dev machine's .env has no cache
	// knobs; loadEnvKey falls through to defaults via the empty value).
	t.Setenv("PIXTOK_CACHE_TTL", "")
	t.Setenv("PIXTOK_CACHE_ENTRIES", "")
	t.Setenv("PIXTOK_CACHE_BYTES", "")

	ttl, entries, maxBytes := cacheConfigFromEnv()
	if ttl != 24*time.Hour || entries != 2000 || maxBytes != 512<<20 {
		t.Fatalf("defaults = %v / %d / %d, want 24h / 2000 / 512MB", ttl, entries, maxBytes)
	}
}

func TestCacheConfigParsesPiSizing(t *testing.T) {
	t.Setenv("PIXTOK_CACHE_TTL", "6h")
	t.Setenv("PIXTOK_CACHE_ENTRIES", "300")
	t.Setenv("PIXTOK_CACHE_BYTES", "67108864")

	ttl, entries, maxBytes := cacheConfigFromEnv()
	if ttl != 6*time.Hour || entries != 300 || maxBytes != 64<<20 {
		t.Fatalf("pi sizing = %v / %d / %d, want 6h / 300 / 64MB", ttl, entries, maxBytes)
	}
}

func TestCacheConfigGarbageFallsBack(t *testing.T) {
	// A misconfigured cache must never block boot — each bad value falls
	// back to its default while the good ones still apply.
	t.Setenv("PIXTOK_CACHE_TTL", "not-a-duration")
	t.Setenv("PIXTOK_CACHE_ENTRIES", "-5")
	t.Setenv("PIXTOK_CACHE_BYTES", "lots")

	ttl, entries, maxBytes := cacheConfigFromEnv()
	if ttl != 24*time.Hour || entries != 2000 || maxBytes != 512<<20 {
		t.Fatalf("garbage = %v / %d / %d, want defaults", ttl, entries, maxBytes)
	}
}
