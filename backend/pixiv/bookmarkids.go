package pixiv

import (
	"strconv"
	"sync"
	"time"
)

// bookmarkIDsCache — TTL + single-flight cache for GetBookmarkIDs.
//
// Every app boot calls /api/bookmarks/ids, which walks up to `pages`
// pages of BOTH visibility pools — 12 upstream calls and ~6-7s of
// latency per boot, and during an iOS reload spiral that repeats per
// reload (the Sep 2026 spiral drew 429s from exactly this). The cache
// collapses repeat boots within the TTL to zero upstream traffic.
//
// Failures are NEVER cached (same contract as follow-state): a 429 or
// dead session must surface to the client, and the next boot retries.
// Like/unlike staleness is bounded by the TTL and is invisible in
// practice: the device that made the change already has the new state
// in its shared store.
type bookmarkIDsEntry struct {
	ids     []string
	expires time.Time
}

type bookmarkIDsCall struct {
	done chan struct{}
	ids  []string
	err  error
}

type bookmarkIDsCache struct {
	mu       sync.Mutex
	ttl      time.Duration
	items    map[string]bookmarkIDsEntry
	inflight map[string]*bookmarkIDsCall
}

func newBookmarkIDsCache(ttl time.Duration) *bookmarkIDsCache {
	return &bookmarkIDsCache{
		ttl:      ttl,
		items:    make(map[string]bookmarkIDsEntry),
		inflight: make(map[string]*bookmarkIDsCall),
	}
}

// getOrStart classifies a request:
//   - fresh: the value is served from the TTL cache (call == nil, lead == false)
//   - lead:  this caller must perform the upstream fetch (call != nil)
//   - follower: another caller is fetching; wait on call.done and read
//     the result from the call.
func (b *bookmarkIDsCache) getOrStart(key string) (ids []string, fresh bool, call *bookmarkIDsCall, lead bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if e, ok := b.items[key]; ok && time.Now().Before(e.expires) {
		return e.ids, true, nil, false
	}
	if c, ok := b.inflight[key]; ok {
		return nil, false, c, false
	}
	c := &bookmarkIDsCall{done: make(chan struct{})}
	b.inflight[key] = c
	return nil, false, c, true
}

// finish stores a successful result (errors are NEVER cached) and wakes
// the followers.
func (b *bookmarkIDsCache) finish(key string, call *bookmarkIDsCall, ids []string, err error) {
	b.mu.Lock()
	delete(b.inflight, key)
	if err == nil {
		b.items[key] = bookmarkIDsEntry{ids: ids, expires: time.Now().Add(b.ttl)}
	}
	b.mu.Unlock()
	call.ids = ids
	call.err = err
	close(call.done)
}

// CachedBookmarkIDs is GetBookmarkIDs behind the TTL + single-flight
// cache. A nil cache (literal test clients) falls through to the raw
// call — same convention as followState.
func (c *Client) CachedBookmarkIDs(restrict string, maxPages int) ([]string, error) {
	if c.bookmarkIDs == nil {
		return c.GetBookmarkIDs(restrict, maxPages)
	}
	key := restrict + "|" + strconv.Itoa(maxPages)
	ids, fresh, call, lead := c.bookmarkIDs.getOrStart(key)
	if fresh {
		return ids, nil
	}
	if !lead {
		<-call.done
		return call.ids, call.err
	}
	ids, err := c.GetBookmarkIDs(restrict, maxPages)
	c.bookmarkIDs.finish(key, call, ids, err)
	return ids, err
}

const bookmarkIDsTTL = 5 * time.Minute
