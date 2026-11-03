package main

// Shutdown cleanup (review finding L3). Two failure modes mattered:
//   - the cache reaper goroutine was never stopped, and
//   - prefs.Close() ran even when Shutdown timed out with handlers still
//     running, turning their preference writes into "database is closed".
// One cleanup path now owns both, so every exit (boot failure, listen
// error, signal) behaves the same.

import (
	"path/filepath"
	"testing"
	"time"
)

func TestImageCacheStopStopsReaper(t *testing.T) {
	c := newImageCache(time.Hour, 10, 1<<20)
	done := make(chan struct{})
	go func() {
		c.Stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop() did not return — the reaper goroutine is still running")
	}
	select {
	case <-c.reapDone:
	default:
		t.Fatal("reaper goroutine still live after Stop")
	}
	// Idempotent: a second Stop must not panic (double close) or block.
	c.Stop()
}

func TestShutdownCleanupClosesPrefsOnlyAfterCleanDrain(t *testing.T) {
	store, err := openPrefs(filepath.Join(t.TempDir(), "prefs.db"))
	if err != nil {
		t.Fatalf("openPrefs: %v", err)
	}
	cache := newImageCache(time.Hour, 10, 1<<20)

	// Timed-out drain: handlers may still be writing — the DB must stay
	// open and usable.
	shutdownCleanup(cache, store, false)
	if err := store.SetImageSize("large"); err != nil {
		t.Fatalf("prefs db closed despite a failed drain: %v", err)
	}

	// Clean drain: the DB is closed and a later write fails.
	shutdownCleanup(cache, store, true)
	if err := store.SetImageSize("large"); err == nil {
		t.Fatal("prefs db still writable after a clean shutdown")
	}
}

func TestShutdownCleanupHandlesMissingPieces(t *testing.T) {
	// No prefs DB (open failed) and no cache: the cleanup path must not
	// panic on either.
	shutdownCleanup(nil, nil, true)
	shutdownCleanup(nil, nil, false)
}
