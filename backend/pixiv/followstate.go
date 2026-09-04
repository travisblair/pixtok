package pixiv

import (
	"sync"
	"time"
)

// followStateTTL is the follow-state cache window (see newFollowStateCache).
const followStateTTL = 30 * time.Minute

// followStateCache — TTL cache + per-user-id single-flight for
// IsFollowed.
//
// The frontend fetches follow state per card on every mount: a strip
// feed renders ~30 cards, each firing /v1/user/detail, with the same
// artists repeated across cards. Uncached, those bursts trip pixiv's
// app-API rate limit (429) and every follow button vanishes (the
// frontend hides the button on unknown state). The cache collapses the
// burst to ONE upstream call per unique artist per TTL window.
//
// Deliberately NO retry on 429: retrying a rate-limited endpoint only
// adds pressure and draws attention. Failures are not cached, so the
// next natural render retries once the window has passed.
//
// invalidation: SetFollow (a successful follow/unfollow) calls
// invalidate() so the new state is visible immediately instead of up
// to TTL later. The per-id epoch makes an invalidation race-safe
// against an in-flight fetch: a call that STARTED before the
// invalidation cannot resurrect the stale value when it finishes.
type followStateEntry struct {
	value   bool
	expires time.Time
}

// followStateCall is a single-flight ticket. The leader performs the
// upstream fetch and calls finish(); followers block on done and read
// value/err after it closes. epoch is the id's epoch when the call
// started — finish() stores only if it still matches.
type followStateCall struct {
	done  chan struct{}
	value bool
	err   error
	epoch uint64
}

type followStateCache struct {
	mu       sync.Mutex
	ttl      time.Duration
	items    map[string]followStateEntry
	inflight map[string]*followStateCall
	epochs   map[string]uint64
}

func newFollowStateCache(ttl time.Duration) *followStateCache {
	return &followStateCache{
		ttl:      ttl,
		items:    make(map[string]followStateEntry),
		inflight: make(map[string]*followStateCall),
		epochs:   make(map[string]uint64),
	}
}

// getOrStart classifies a request:
//   - fresh: the value is served from the TTL cache (call == nil, lead == false)
//   - lead:  this caller must perform the upstream fetch (call != nil)
//   - follower: another caller is fetching; wait on call.done
func (f *followStateCache) getOrStart(id string) (value bool, fresh bool, call *followStateCall, lead bool) {
	f.mu.Lock()
	if e, ok := f.items[id]; ok && time.Now().Before(e.expires) {
		f.mu.Unlock()
		return e.value, true, nil, false
	}
	if c, ok := f.inflight[id]; ok {
		f.mu.Unlock()
		return false, false, c, false
	}
	c := &followStateCall{done: make(chan struct{}), epoch: f.epochs[id]}
	f.inflight[id] = c
	f.mu.Unlock()
	return false, false, c, true
}

// invalidate drops the cached value for id and bumps the id's epoch so
// an in-flight call (started before this invalidation) is discarded by
// finish() instead of resurrecting the stale value. Bounded: epochs are
// deleted by finish() once the last call for an id completes.
func (f *followStateCache) invalidate(id string) {
	f.mu.Lock()
	delete(f.items, id)
	f.epochs[id]++
	f.mu.Unlock()
}

// finish stores a successful result (errors are NEVER cached) and wakes
// the followers. A result whose epoch was bumped by invalidate() is
// dropped — it predates the user's own toggle.
func (f *followStateCache) finish(id string, call *followStateCall, value bool, err error) {
	f.mu.Lock()
	delete(f.inflight, id)
	if err == nil && f.epochs[id] == call.epoch {
		f.items[id] = followStateEntry{value: value, expires: time.Now().Add(f.ttl)}
		// Lazy sweep: a long browse session can accumulate thousands of
		// artists in one TTL window. Drop expired entries when the map
		// grows beyond sanity (single user — this is a bound, not a
		// policy).
		if len(f.items) > 4096 {
			now := time.Now()
			for k, v := range f.items {
				if now.After(v.expires) {
					delete(f.items, k)
				}
			}
		}
	}
	if f.epochs[id] == call.epoch {
		delete(f.epochs, id)
	}
	f.mu.Unlock()
	call.value = value
	call.err = err
	close(call.done)
}
