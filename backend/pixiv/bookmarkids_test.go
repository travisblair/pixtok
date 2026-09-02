package pixiv

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// Tests the TTL + single-flight semantics of bookmarkIDsCache directly —
// the upstream walk is exercised elsewhere (client_test.go); here the
// contract is: fresh hits serve from cache, expiry refetches, concurrent
// callers single-flight onto one fetch, and failures are never cached.

func TestBookmarkIDsCacheFreshHit(t *testing.T) {
	b := newBookmarkIDsCache(5 * time.Minute)
	b.mu.Lock()
	b.items["private|6"] = bookmarkIDsEntry{
		ids:     []string{"1", "2"},
		expires: time.Now().Add(5 * time.Minute),
	}
	b.mu.Unlock()

	ids, fresh, _, _ := b.getOrStart("private|6")
	if !fresh {
		t.Fatal("expected a fresh cache hit")
	}
	if len(ids) != 2 || ids[0] != "1" {
		t.Fatalf("wrong cached ids: %v", ids)
	}
}

func TestBookmarkIDsCacheExpiryRefetches(t *testing.T) {
	b := newBookmarkIDsCache(time.Minute)
	b.mu.Lock()
	b.items["private|6"] = bookmarkIDsEntry{
		ids:     []string{"stale"},
		expires: time.Now().Add(-time.Second), // already expired
	}
	b.mu.Unlock()

	_, fresh, call, lead := b.getOrStart("private|6")
	if fresh {
		t.Fatal("expired entry must not be served fresh")
	}
	if !lead || call == nil {
		t.Fatal("expired entry must yield a lead fetch")
	}
}

func TestBookmarkIDsCacheSingleFlight(t *testing.T) {
	b := newBookmarkIDsCache(time.Minute)
	_, _, _, lead := b.getOrStart("public|6")
	if !lead {
		t.Fatal("first caller must lead")
	}
	// Second caller before finish() → follower on the same call.
	_, fresh, call, lead2 := b.getOrStart("public|6")
	if fresh || lead2 || call == nil {
		t.Fatal("concurrent caller must follow, not lead or serve fresh")
	}
}

func TestBookmarkIDsCacheFinishStoresAndWakesFollowers(t *testing.T) {
	b := newBookmarkIDsCache(time.Minute)
	_, _, call, _ := b.getOrStart("public|6")
	var wg sync.WaitGroup
	wg.Add(1)
	var got []string
	var gotErr error
	go func() {
		defer wg.Done()
		<-call.done
		got, gotErr = call.ids, call.err
	}()
	b.finish("public|6", call, []string{"9", "8"}, nil)
	wg.Wait()
	if len(got) != 2 || got[0] != "9" || gotErr != nil {
		t.Fatalf("follower got %v, %v", got, gotErr)
	}
	// Post-finish callers within TTL serve fresh.
	ids, fresh, _, _ := b.getOrStart("public|6")
	if !fresh || len(ids) != 2 {
		t.Fatalf("post-finish call must be fresh, got %v fresh=%v", ids, fresh)
	}
}

func TestBookmarkIDsCacheErrorsNeverCached(t *testing.T) {
	b := newBookmarkIDsCache(time.Minute)
	_, _, call, _ := b.getOrStart("private|6")
	b.finish("private|6", call, nil, errors.New("upstream 429"))
	// Error → nothing stored, so the next caller leads again.
	_, fresh, _, lead := b.getOrStart("private|6")
	if fresh || !lead {
		t.Fatal("failed fetch must not be cached")
	}
}
