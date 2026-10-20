package pixiv

import (
	"errors"
	"strconv"
	"sync"
	"time"
)

// bookmarkCooldownDuration is how long a 429 on a bookmark walk keeps
// the walk from being attempted again. The walk is a per-boot firehose
// (up to 2 × maxPages requests), and during an iOS reload spiral every
// reload repeated it — adding pressure exactly while pixiv was asking
// for less. NOT a retry: reloads inside the window answer from the
// negative cache without touching upstream.
const bookmarkCooldownDuration = 5 * time.Minute

// ErrBookmarkCooldown marks a bookmark-id answer served during the 429
// cooldown window: the walk was skipped, not attempted.
var ErrBookmarkCooldown = errors.New("bookmark walk cooling down after upstream 429")

// bookmarkIDsCache — TTL + single-flight cache for GetBookmarkIDs.
//
// Every app boot calls /api/bookmarks/ids, which walks up to `pages`
// pages of BOTH visibility pools — 12 upstream calls and ~6-7s of
// latency per boot, and during an iOS reload spiral that repeats per
// reload (the Sep 2026 spiral drew 429s from exactly this). The cache
// collapses repeat boots within the TTL to zero upstream traffic.
//
// Failures are NEVER cached as values (same contract as follow-state): a
// dead session must surface to the client and the next boot retries. The
// one exception is a 429, which arms bookmarkCooldownDuration of
// negative caching so a reload spiral cannot re-walk twelve pages while
// pixiv's limiter is asking for less.
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
	gen  uint64
}

type bookmarkIDsCache struct {
	mu       sync.Mutex
	ttl      time.Duration
	items    map[string]bookmarkIDsEntry
	inflight map[string]*bookmarkIDsCall
	// gen identifies the credentials the cache was filled under. reset()
	// bumps it so a walk that started under the previous account cannot
	// deposit that account's ids into the new account's cache.
	gen uint64
	// cooldownUntil is the end of the 429 negative-cache window (zero =
	// not cooling).
	cooldownUntil time.Time
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
	c := &bookmarkIDsCall{done: make(chan struct{}), gen: b.gen}
	b.inflight[key] = c
	return nil, false, c, true
}

// reset drops every cached value; see followStateCache.reset. The
// generation bump keeps an in-flight walk started under the old
// credentials from being stored.
func (b *bookmarkIDsCache) reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.gen++
	b.items = make(map[string]bookmarkIDsEntry)
}

// finish stores a successful result (errors are NEVER cached) and wakes
// the followers.
func (b *bookmarkIDsCache) finish(key string, call *bookmarkIDsCall, ids []string, err error) {
	b.mu.Lock()
	delete(b.inflight, key)
	if err == nil && call.gen == b.gen {
		b.items[key] = bookmarkIDsEntry{ids: ids, expires: time.Now().Add(b.ttl)}
	}
	// Only a 429 opens the window: other failures stay uncached so the
	// next natural attempt retries them (a dead session heals on login).
	var se *statusError
	if errors.As(err, &se) && se.status == 429 {
		b.cooldownUntil = time.Now().Add(bookmarkCooldownDuration)
	}
	b.mu.Unlock()
	call.ids = ids
	call.err = err
	close(call.done)
}

// coolingDown reports whether the 429 negative-cache window is open.
func (b *bookmarkIDsCache) coolingDown() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return time.Now().Before(b.cooldownUntil)
}

// CachedBookmarkIDs is GetBookmarkIDs behind the TTL + single-flight
// cache. A nil cache (literal test clients) falls through to the raw
// call — same convention as followState.
func (c *Client) CachedBookmarkIDs(restrict string, maxPages int) ([]string, error) {
	if c.bookmarkIDs == nil {
		return c.GetBookmarkIDs(restrict, maxPages)
	}
	key := restrict + "|" + strconv.Itoa(maxPages)
	// While the 429 window is open, answer from the negative cache
	// without touching upstream: a reload spiral must not re-walk the
	// bookmarks pages the way it used to.
	if c.bookmarkIDs.coolingDown() {
		return nil, ErrBookmarkCooldown
	}
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
