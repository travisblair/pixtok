package pixiv

import (
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fsTransport serves requests through a test-supplied function, so a
// detail call can be parked mid-flight.
type fsTransport func(*http.Request) (*http.Response, error)

func (f fsTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func fsJSON(req *http.Request, body string) *http.Response {
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

// Regression (review 1017-1 F-10): invalidate() bumped the id's epoch so
// the in-flight answer was kept OUT of the cache, but the ticket stayed
// registered. A caller arriving after the user's toggle joined that
// ticket and was handed the PRE-toggle value — the exact stale render
// the epoch was meant to prevent.
func TestFollowStateFollowerSeesPostToggleValue(t *testing.T) {
	firstEntered := make(chan struct{})
	release := make(chan struct{})
	var calls int32
	rt := fsTransport(func(req *http.Request) (*http.Response, error) {
		if atomic.AddInt32(&calls, 1) == 1 {
			close(firstEntered)
			<-release
			return fsJSON(req, `{"user":{"is_followed":true}}`), nil
		}
		return fsJSON(req, `{"user":{"is_followed":false}}`), nil
	})
	c := &Client{
		expiresAt:   time.Now().Add(time.Hour),
		http:        &http.Client{Transport: rt},
		followState: newFollowStateCache(time.Minute),
	}

	var wg sync.WaitGroup
	var leaderValue, followerValue bool
	var leaderErr, followerErr error

	wg.Add(1)
	go func() {
		defer wg.Done()
		leaderValue, leaderErr = c.IsFollowed("12345")
	}()
	<-firstEntered

	// The user toggles follow for this artist while the detail fetch is
	// still in flight.
	c.followState.invalidate("12345")

	wg.Add(1)
	go func() {
		defer wg.Done()
		followerValue, followerErr = c.IsFollowed("12345")
	}()
	// Give the follower time to reach the single-flight ticket. If it
	// led its own fetch the premise is broken, not the fix — say so
	// instead of passing by accident.
	time.Sleep(50 * time.Millisecond)
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("follower did not join the in-flight call (upstream calls = %d)", got)
	}

	close(release)
	wg.Wait()

	if leaderErr != nil {
		t.Fatalf("leader: %v", leaderErr)
	}
	if followerErr != nil {
		t.Fatalf("follower: %v", followerErr)
	}
	// The leader's answer predates the toggle and it returns what it
	// fetched; the follower is the caller the finding names and must
	// re-fetch instead of rendering the pre-toggle value.
	if followerValue {
		t.Fatal("follower rendered the PRE-toggle value after invalidate() — the toggle is invisible on that card")
	}
	if leaderErr != nil || !leaderValue {
		t.Fatalf("leader = %v, %v; want the pre-toggle true it asked for", leaderValue, leaderErr)
	}
	// At least one re-fetch: the superseded answer must not be the last
	// word. (Exactly which caller leads it depends on scheduling.)
	if got := atomic.LoadInt32(&calls); got < 2 {
		t.Fatalf("upstream calls = %d, want >= 2 (the superseded answer must be re-fetched)", got)
	}
}
