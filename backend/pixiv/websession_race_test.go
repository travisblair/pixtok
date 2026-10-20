package pixiv

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestWebSessionSwapRace exercises the login-capture-vs-feed race:
// SetWebSession swaps phpSessID/csrfTokenCache while concurrent web
// requests read them. Run under -race this fails on any unsynchronized
// access (the reads used to touch the bare fields with no lock).
func TestWebSessionSwapRace(t *testing.T) {
	// SetWebSession persists to .env, and UpdateEnvFile CREATES the file
	// when it is missing. With the test's CWD at backend/pixiv that write
	// resolved to ../.env = backend/.env — a live operator credential
	// store — and rewrote its web session 200 times. Pin the resolver at
	// a sandbox file instead.
	t.Setenv("PIXTOK_ENV_FILE", filepath.Join(t.TempDir(), ".env"))

	var upstreamMu sync.Mutex
	upstreamHits := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamMu.Lock()
		upstreamHits++
		upstreamMu.Unlock()
		w.WriteHeader(500) // body content irrelevant; we only exercise the session reads
	}))
	defer ts.Close()

	c := &Client{
		http: &http.Client{Timeout: 5 * time.Second},
	}
	c.setWebCache("111_testsession", "tok0")

	const workers = 8
	const iters = 200

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Swapper: hammers the web-session swap like an in-app login capture
	// completing mid-browse.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iters; i++ {
			c.setWebCache(
				"111_session_"+string(rune('a'+i%26)),
				"tok"+string(rune('a'+i%26)),
			)
			// SetWebSession also persists to .env. The sandbox pinned
			// above must accept the write — otherwise the swap this
			// test exists to exercise never happens.
			if err := c.SetWebSession("111_session_x", "tok_x"); err != nil {
				t.Errorf("SetWebSession: %v", err)
			}
		}
		close(stop)
	}()

	// Readers: every web surface that touches the session id.
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				_ = c.webSessionID()
				_, _ = c.webSession()
				_, _ = c.GetBookmarkIDs("public", 1) // uid parse + cookie header read
				_, _ = c.webGet(ts.URL + "/x")
				_, _ = c.GetUgoiraMeta("123")
			}
		}()
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("race test timed out")
	}
	if upstreamHits == 0 {
		t.Fatal("upstream never reached — test wired wrong")
	}
}
