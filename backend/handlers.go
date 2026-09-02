package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/travisblair/pixtok/pixiv"
)

// pixivAPI is the surface the HTTP handlers need. *pixiv.Client satisfies
// it; tests inject a fake. Keeps handlers testable without any network.
type pixivAPI interface {
	GetRecommended() ([]byte, error)
	GetRankingIllust(mode string) ([]byte, error)
	GetNewestIllust(r18 bool, lastID string) ([]byte, error)
	GetTopIllust(mode string) ([]byte, error)
	GetStreet(nextParams string) ([]byte, error)
	GetRelated(illustID string) ([]byte, error)
	GetWorkRecommend(illustID string) ([]byte, error)
	GetUserIllusts(userID string) ([]byte, error)
	GetUgoiraMeta(illustID string) ([]byte, error)
	BookmarkAdd(illustID string, isPrivate bool) error
	BookmarkDelete(illustID string) error
	GetBookmarkIDs(restrict string, maxPages int) ([]string, error)
	CachedBookmarkIDs(restrict string, maxPages int) ([]string, error)
	GetBookmarkIllusts(restrict string) ([]byte, error)
	GetBookmarkPage(tag string, offset, limit int, order string) ([]byte, error)
	GetBookmarkTags() ([]byte, error)
	SetFollow(userID, restrict string, follow bool) error
	IsFollowed(userID string) (bool, error)
	SearchArtworks(word string, opts pixiv.SearchOpts, page int) ([]byte, error)
	SearchUsers(nick, sMode string, page int) ([]byte, error)
	ProxyNext(nextURL string) ([]byte, error)
	ProxyImageStream(imgURL string, w http.ResponseWriter) ([]byte, string, error)
	// ── login capture (the /api/auth/* protocol) ──
	ExchangePkce(code, verifier string) (refresh, access string, expiresIn int, err error)
	SetTokens(refresh, access string, expiresIn int) error
	SetWebSession(phpsessid, csrfToken string) error
	ScrapeCsrfFor(phpsessid string) (string, error)
	AuthHealth() (appOK bool, webOK bool)
}

// imgFetchSlots bounds CONCURRENT upstream image fetches (reviewer
// finding): the rate limiter caps request COUNT, not in-flight fetches —
// every concurrent cache miss holds an outbound connection and buffers
// bytes, and on the Pi's 96MiB memory budget unbounded misses are an OOM
// vector. Saturation QUEUES instead of failing fast: a grid/search
// render fires ~35 image fetches at once, and the old 429-on-saturation
// failed ~27 of them permanently (broken images until a manual retry
// tap). Waiters block for a free slot and complete late — slow images,
// not broken ones. Misses only: cache hits never consume a slot.
const maxConcurrentImageFetches = 8

// maxImgQueueWaiters caps how many requests may BLOCK waiting for an
// image slot. Beyond it requests still fail fast (429 + Retry-After) so
// a pathological burst can't accumulate unbounded waiting goroutines on
// the Pi.
const maxImgQueueWaiters = 24

var (
	imgFetchSlots   = make(chan struct{}, maxConcurrentImageFetches)
	imgQueueWaiters atomic.Int64
)

// sanitizeLogText strips control characters from client-supplied
// journal text so /api/log payloads can't inject or forge log lines.
func sanitizeLogText(s string) string {
	if !strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return s
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
}

// pkceStore holds in-flight PKCE challenges: single-use, short-TTL,
// capped. The proxied login (pkce/start → px/* → server-side callback)
// creates the verifier/challenge at start and consumes it at the
// callback.
type pkceEntry struct {
	verifier string
	expires  time.Time
}

type pkceStore struct {
	mu      sync.Mutex
	entries map[string]pkceEntry
}

func newPkceStore() *pkceStore {
	return &pkceStore{entries: make(map[string]pkceEntry)}
}

const pkceTTL = 10 * time.Minute
const pkceMaxEntries = 32

func (s *pkceStore) put(state, verifier string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Shed stale entries; if still full, drop an arbitrary one (map
	// iteration makes no attempt at LRU — that's fine at this scale).
	for st, e := range s.entries {
		if time.Now().After(e.expires) {
			delete(s.entries, st)
		}
	}
	if len(s.entries) >= pkceMaxEntries {
		for st := range s.entries { // map iteration — any victim works
			delete(s.entries, st)
			break
		}
	}
	s.entries[state] = pkceEntry{verifier: verifier, expires: time.Now().Add(pkceTTL)}
}

func (s *pkceStore) take(state string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[state]
	if !ok {
		return "", false
	}
	delete(s.entries, state) // single-use
	if time.Now().After(e.expires) {
		return "", false
	}
	return e.verifier, true
}

func randomB64(bytes int) (string, error) {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// newServer wires all routes against the given API client and wraps them
// in the API-key gate. Extracted from main() so handler behavior is
// testable with a fake client via httptest.
func newServer(api pixivAPI, cache *imageCache, apiKey string) http.Handler {
	return apiKeyGate(apiKey, newServerBase(api, cache))
}

// buildRoutes registers every route on the mux (no gate — the caller
// decides whether to wrap with apiKeyGate).
func buildRoutes(mux *http.ServeMux, api pixivAPI, cache *imageCache) {
	pkce := newPkceStore()

	// ── Login capture (the /api/auth/* protocol). ──
	// The legacy manual-capture routes (POST /api/auth/pkce/begin,
	// POST /api/auth/pkce/complete, POST /api/auth/session) were REMOVED
	// (reviewer finding): they belonged to the deleted Node shim
	// architecture and are unreachable in the proxied in-app flow
	// (GET /api/auth/pkce/start → px/* proxy → server-side callback).
	// /api/auth/status remains — the Account screen's health check.

	mux.HandleFunc("/api/auth/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		appOK, webOK := api.AuthHealth()
		writeJSON(w, map[string]bool{"app_api": appOK, "web_session": webOK})
	})

	// POST /api/log — client breadcrumbs. The frontend fires small
	// structured events (gesture state, layer pops, follow-button
	// outcomes, gate transitions) so the server journal carries the
	// client's story: the phone has no DevTools, so "the app did X then
	// Y" must be reconstructable from this journal after the fact.
	// Scope is allowlisted, bodies are capped, and the route sits behind
	// the same gate as everything else.
	mux.HandleFunc("POST /api/log", func(w http.ResponseWriter, r *http.Request) {
		var entry struct {
			Session string `json:"session"`
			Scope   string `json:"scope"`
			Msg     string `json:"msg"`
			Data    any    `json:"data"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&entry); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		switch entry.Scope {
		case "gesture", "layers", "follow", "gate", "boot", "app", "ugoira", "crash":
		default:
			http.Error(w, "invalid scope", http.StatusBadRequest)
			return
		}
		if len(entry.Session) > 32 {
			entry.Session = entry.Session[:32]
		}
		// Sanitize journal text (reviewer finding): /api/log is
		// attacker-controllable text landing in server.log — control chars
		// and newlines must not forge or split journal lines.
		entry.Session = sanitizeLogText(entry.Session)
		entry.Msg = sanitizeLogText(entry.Msg)
		msg := entry.Msg
		if len(msg) > 256 {
			msg = msg[:256]
		}
		var dataStr string
		if entry.Data != nil {
			if b, err := json.Marshal(entry.Data); err == nil {
				dataStr = string(b)
				if len(dataStr) > 512 {
					dataStr = dataStr[:512]
				}
			}
		}
		log.Printf("CLIENT [%s] %s: %s %s", entry.Session, entry.Scope, msg, dataStr)
		writeJSON(w, map[string]bool{"ok": true})
	})

	// POST /api/auth/launch was here — removed. The login shim
	// (tools/login-shim) was deleted in favour of the in-app proxied
	// login flow (pixiv's own form served through this backend).

	mux.HandleFunc("/api/street", func(w http.ResponseWriter, r *http.Request) {
		// Body is the nextParams cursor JSON from the previous response
		// (empty for the first page). The backend owns the street URL, so
		// the body is opaque data, not an SSRF vector.
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		nextParams, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		body, err := api.GetStreet(strings.TrimSpace(string(nextParams)))
		if err != nil {
			log.Printf("ERROR street: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}

		transformed, err := transformStreet(body)
		if err != nil {
			log.Printf("ERROR transform street: %v", err)
			http.Error(w, "transform error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write(transformed)
	})

	mux.HandleFunc("GET /api/recommended", func(w http.ResponseWriter, r *http.Request) {
		body, err := api.GetRecommended()
		if err != nil {
			log.Printf("ERROR recommended: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	})

	mux.HandleFunc("GET /api/newest", func(w http.ResponseWriter, r *http.Request) {
		r18 := r.URL.Query().Get("r18") == "true"
		lastID := r.URL.Query().Get("lastId")
		if lastID != "" && !pixiv.ValidID(lastID) {
			http.Error(w, "invalid lastId", http.StatusBadRequest)
			return
		}
		body, err := api.GetNewestIllust(r18, lastID)
		if err != nil {
			log.Printf("ERROR newest: %v", err)
			if errors.Is(err, pixiv.ErrInvalidParam) {
				http.Error(w, "invalid lastId", http.StatusBadRequest)
				return
			}
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}

		transformed, err := transformNewest(body, r18)
		if err != nil {
			log.Printf("ERROR transform newest: %v", err)
			http.Error(w, "transform error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write(transformed)
	})

	mux.HandleFunc("GET /api/topillust", func(w http.ResponseWriter, r *http.Request) {
		// The /illustration top page feed (mode all|r18 — validated in
		// the client). Distinct from /api/top (the ranking feed).
		mode := r.URL.Query().Get("mode")
		body, err := api.GetTopIllust(mode)
		if err != nil {
			log.Printf("ERROR topillust: %v", err)
			if errors.Is(err, pixiv.ErrInvalidParam) {
				http.Error(w, "invalid top mode", http.StatusBadRequest)
				return
			}
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}

		transformed, err := transformTopIllust(body)
		if err != nil {
			log.Printf("ERROR transform topillust: %v", err)
			http.Error(w, "transform error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write(transformed)
	})

	mux.HandleFunc("GET /api/top", func(w http.ResponseWriter, r *http.Request) {
		mode := r.URL.Query().Get("mode")
		body, err := api.GetRankingIllust(mode)
		if err != nil {
			log.Printf("ERROR ranking: %v", err)
			if errors.Is(err, pixiv.ErrInvalidParam) {
				http.Error(w, "invalid ranking mode", http.StatusBadRequest)
				return
			}
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}

		// App-API passthrough: the response is already the FeedResponse
		// shape the frontend speaks (illusts + next_url), ids normalized
		// client-side like every other app-API feed.
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	})

	mux.HandleFunc("GET /api/user/", func(w http.ResponseWriter, r *http.Request) {
		// Artist library: GET /api/user/{id}/illusts (read-only).
		if !strings.HasSuffix(r.URL.Path, "/illusts") {
			http.NotFound(w, r)
			return
		}
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/user/"), "/illusts")
		if !pixiv.ValidID(id) {
			http.Error(w, "invalid user id", http.StatusBadRequest)
			return
		}
		body, err := api.GetUserIllusts(id)
		if err != nil {
			log.Printf("ERROR user illusts(%s): %v", id, err)
			if errors.Is(err, pixiv.ErrNotFound) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	})

	mux.HandleFunc("/api/bookmarks/ids", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		pages := 6
		if p := r.URL.Query().Get("pages"); p != "" {
			n, err := strconv.Atoi(p)
			if err != nil || n < 1 || n > 10 {
				http.Error(w, "invalid pages", http.StatusBadRequest)
				return
			}
			pages = n
		}
		// Both visibility pools: pixtok likes are private; the site's
		// heart makes public ones. Merge so hearts are right either way.
		// Cached: repeat boots (and iOS reload spirals) must not re-walk
		// 12 upstream pages every time — see pixiv/bookmarkids.go.
		privateIDs, err := api.CachedBookmarkIDs("private", pages)
		if err != nil {
			log.Printf("ERROR bookmark ids (private): %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		publicIDs, err := api.CachedBookmarkIDs("public", pages)
		if err != nil {
			log.Printf("ERROR bookmark ids (public): %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		seen := make(map[string]bool, len(privateIDs)+len(publicIDs))
		ids := make([]int, 0, len(privateIDs)+len(publicIDs))
		for _, raw := range append(privateIDs, publicIDs...) {
			if seen[raw] {
				continue
			}
			seen[raw] = true
			if n, err := strconv.Atoi(raw); err == nil {
				ids = append(ids, n)
			}
		}
		writeJSON(w, map[string]any{"ids": ids})
	})

	// ── Search (the site's search pages: tag/free-text artworks + users) ──

	// Bookmarks tab feed: the user's bookmarked works (private by
	// default — pixtok likes are private). Standard app-API passthrough;
	// pagination rides the existing /api/next route.
	mux.HandleFunc("GET /api/bookmarks", func(w http.ResponseWriter, r *http.Request) {
		// The bookmarks PAGE experience (crawl-verified): tag filter +
		// blind offset pagination + sort, via the web AJAX endpoint.
		// limit 48 matches the site's own page size. rest=show is the
		// page's default (public bookmarks).
		tag := r.URL.Query().Get("tag")
		if len(tag) > 64 {
			http.Error(w, "invalid tag", http.StatusBadRequest)
			return
		}
		offset, err := strconv.Atoi(r.URL.Query().Get("offset"))
		if err != nil || offset < 0 || offset > 100000 {
			http.Error(w, "invalid offset", http.StatusBadRequest)
			return
		}
		order := r.URL.Query().Get("order")
		if order == "" {
			order = "desc"
		}
		if order != "desc" && order != "asc" {
			http.Error(w, "invalid order", http.StatusBadRequest)
			return
		}
		const pageSize = 48
		body, err := api.GetBookmarkPage(tag, offset, pageSize, order)
		if err != nil {
			log.Printf("ERROR bookmark page: %v", err)
			if errors.Is(err, pixiv.ErrInvalidParam) {
				http.Error(w, "invalid parameter", http.StatusBadRequest)
				return
			}
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		out, err := transformBookmarkPage(body, tag, offset, pageSize, order)
		if err != nil {
			log.Printf("ERROR bookmark transform: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(out)
	})

	mux.HandleFunc("GET /api/bookmarks/tags", func(w http.ResponseWriter, r *http.Request) {
		body, err := api.GetBookmarkTags()
		if err != nil {
			log.Printf("ERROR bookmark tags: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		out, err := transformBookmarkTags(body)
		if err != nil {
			log.Printf("ERROR bookmark tags transform: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(out)
	})

	// Follow/unfollow — account-mutating, POST only (same rule as
	// like/unlike). /followed reports the current state for the follow
	// button. Method-specific patterns: the artist route owns the
	// methodless GET /api/user/ subtree, and method-specific wins there.
	handleFollow := func(w http.ResponseWriter, r *http.Request, follow bool) {
		id := r.PathValue("id")
		if !pixiv.ValidID(id) {
			http.Error(w, "invalid user id", http.StatusBadRequest)
			return
		}
		if err := api.SetFollow(id, "public", follow); err != nil {
			log.Printf("ERROR follow (%v): %v", follow, err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}
	mux.HandleFunc("POST /api/user/{id}/follow", func(w http.ResponseWriter, r *http.Request) {
		handleFollow(w, r, true)
	})
	mux.HandleFunc("POST /api/user/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		handleFollow(w, r, false)
	})
	mux.HandleFunc("GET /api/user/{id}/followed", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !pixiv.ValidID(id) {
			http.Error(w, "invalid user id", http.StatusBadRequest)
			return
		}
		followed, err := api.IsFollowed(id)
		if err != nil {
			if errors.Is(err, pixiv.ErrFollowCooldown) {
				// Circuit breaker open after an upstream 429: "unknown"
				// is the honest answer, not an error. A null followed
				// hides the button client-side with no toast and no
				// journal ERROR flood.
				writeJSON(w, map[string]any{"followed": nil})
				return
			}
			log.Printf("ERROR follow state: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]any{"followed": followed})
	})

	mux.HandleFunc("GET /api/search/artworks", func(w http.ResponseWriter, r *http.Request) {
		word := r.URL.Query().Get("word")
		opts := pixiv.SearchOpts{
			Order:  r.URL.Query().Get("order"),
			Mode:   r.URL.Query().Get("mode"),
			SMode:  r.URL.Query().Get("s_mode"),
			Type:   r.URL.Query().Get("type"),
			AIType: r.URL.Query().Get("ai_type"),
			SCD:    r.URL.Query().Get("scd"),
			SCE:    r.URL.Query().Get("sce"),
		}
		if opts.Order == "" {
			opts.Order = "date_d"
		}
		if opts.Mode == "" {
			opts.Mode = "all"
		}
		if opts.SMode == "" {
			// The site's search box uses FULL tag match (verified live
			// crawl) — partial match drifts from pixiv's real results.
			opts.SMode = "s_tag_full"
		}
		if opts.Type == "" {
			// Default: the artworks endpoint (pixiv's own search-page
			// default — illustrations + manga mixed, as the site shows).
			opts.Type = "all"
		}
		if opts.AIType == "" {
			opts.AIType = "0"
		}
		p := 1
		if ps := r.URL.Query().Get("p"); ps != "" {
			n, err := strconv.Atoi(ps)
			if err != nil || n < 1 || n > 1000 {
				http.Error(w, "invalid page", http.StatusBadRequest)
				return
			}
			p = n
		}

		body, err := api.SearchArtworks(word, opts, p)
		if err != nil {
			log.Printf("ERROR search artworks: %v", err)
			if errors.Is(err, pixiv.ErrInvalidParam) {
				http.Error(w, "invalid parameter", http.StatusBadRequest)
				return
			}
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		resp, err := transformSearchArtworks(body)
		if err != nil {
			log.Printf("ERROR search transform: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		resp.Page = p
		if p < resp.LastPage {
			u := fmt.Sprintf("/api/search/artworks?word=%s&order=%s&mode=%s&s_mode=%s&type=%s&ai_type=%s&p=%d",
				url.QueryEscape(word), opts.Order, opts.Mode, opts.SMode, opts.Type, opts.AIType, p+1)
			if opts.SCD != "" {
				u += "&scd=" + url.QueryEscape(opts.SCD)
			}
			if opts.SCE != "" {
				u += "&sce=" + url.QueryEscape(opts.SCE)
			}
			resp.NextURL = &u
		}
		writeJSON(w, resp)
	})

	mux.HandleFunc("GET /api/search/users", func(w http.ResponseWriter, r *http.Request) {
		nick := r.URL.Query().Get("nick")
		sMode := r.URL.Query().Get("s_mode")
		if sMode == "" {
			sMode = "s_usr"
		}
		p := 1
		if ps := r.URL.Query().Get("p"); ps != "" {
			n, err := strconv.Atoi(ps)
			if err != nil || n < 1 || n > 1000 {
				http.Error(w, "invalid page", http.StatusBadRequest)
				return
			}
			p = n
		}

		body, err := api.SearchUsers(nick, sMode, p)
		if err != nil {
			log.Printf("ERROR search users: %v", err)
			if errors.Is(err, pixiv.ErrInvalidParam) {
				http.Error(w, "invalid parameter", http.StatusBadRequest)
				return
			}
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		resp, err := transformSearchUsers(body)
		if err != nil {
			log.Printf("ERROR search users transform: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		resp.Page = p
		// 10 users per page upstream.
		if p*10 < resp.Total {
			u := fmt.Sprintf("/api/search/users?nick=%s&s_mode=%s&p=%d",
				url.QueryEscape(nick), sMode, p+1)
			resp.NextURL = &u
		}
		writeJSON(w, resp)
	})

	mux.HandleFunc("/api/illust/", func(w http.ResponseWriter, r *http.Request) {
		// Handle like/unlike/related sub-routes. Like/unlike are
		// account-mutating — POST only (a GET must never change state;
		// otherwise any webpage could drive bookmarks via a bare <img>).
		if strings.HasSuffix(r.URL.Path, "/like") {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/illust/"), "/like")
			if !pixiv.ValidID(id) {
				http.Error(w, "invalid illust id", http.StatusBadRequest)
				return
			}
			if err := api.BookmarkAdd(id, true); err != nil {
				log.Printf("ERROR like(%s): %v", id, err)
				http.Error(w, "upstream error", http.StatusBadGateway)
				return
			}
			w.Write([]byte(`{"ok":true}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/unlike") {
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/illust/"), "/unlike")
			if !pixiv.ValidID(id) {
				http.Error(w, "invalid illust id", http.StatusBadRequest)
				return
			}
			if err := api.BookmarkDelete(id); err != nil {
				log.Printf("ERROR unlike(%s): %v", id, err)
				http.Error(w, "upstream error", http.StatusBadGateway)
				return
			}
			w.Write([]byte(`{"ok":true}`))
			return
		}
		if strings.HasSuffix(r.URL.Path, "/recs") {
			// Per-work recommendations (recommend/init for the liked
			// work). Read-only GET — any other method is rejected.
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/illust/"), "/recs")
			if !pixiv.ValidID(id) {
				http.Error(w, "invalid illust id", http.StatusBadRequest)
				return
			}
			body, err := api.GetWorkRecommend(id)
			if err != nil {
				log.Printf("ERROR work recs(%s): %v", id, err)
				if errors.Is(err, pixiv.ErrNotFound) {
					http.Error(w, "not found", http.StatusNotFound)
					return
				}
				http.Error(w, "upstream error", http.StatusBadGateway)
				return
			}
			transformed, err := transformWorkRecommend(body)
			if err != nil {
				log.Printf("ERROR transform work recs: %v", err)
				http.Error(w, "transform error", http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write(transformed)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/ugoira_meta") {
			// Animation metadata for ugoira works (read-only GET).
			if r.Method != http.MethodGet {
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/illust/"), "/ugoira_meta")
			if !pixiv.ValidID(id) {
				http.Error(w, "invalid illust id", http.StatusBadRequest)
				return
			}
			// Meta rides the slow Pi relay like the zip (review finding):
			// the client allows 60s, but without a per-response deadline
			// the server's global 15s WriteTimeout killed the whole
			// handler cycle first — the client's longer wait was
			// illusory. Same override as the image route.
			if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(60 * time.Second)); err != nil {
				log.Printf("WARNING ugoira meta write deadline: %v", err)
			}
			body, err := api.GetUgoiraMeta(id)
			if err != nil {
				log.Printf("ERROR ugoira meta(%s): %v", id, err)
				if errors.Is(err, pixiv.ErrNotFound) {
					http.Error(w, "not found", http.StatusNotFound)
					return
				}
				http.Error(w, "upstream error", http.StatusBadGateway)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write(body)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/related") {
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/illust/"), "/related")
			if !pixiv.ValidID(id) {
				http.Error(w, "invalid illust id", http.StatusBadRequest)
				return
			}
			body, err := api.GetRelated(id)
			if err != nil {
				log.Printf("ERROR related(%s): %v", id, err)
				if errors.Is(err, pixiv.ErrNotFound) {
					http.Error(w, "not found", http.StatusNotFound)
					return
				}
				http.Error(w, "upstream error", http.StatusBadGateway)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write(body)
			return
		}

		http.NotFound(w, r)
	})

	mux.HandleFunc("GET /api/next", func(w http.ResponseWriter, r *http.Request) {
		nextURL := r.URL.Query().Get("url")
		if nextURL == "" {
			http.Error(w, "missing url param", http.StatusBadRequest)
			return
		}

		body, err := api.ProxyNext(nextURL)
		if err != nil {
			log.Printf("ERROR proxy: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	})

	mux.HandleFunc("GET /api/img", func(w http.ResponseWriter, r *http.Request) {
		imgURL := r.URL.Query().Get("url")
		if imgURL == "" {
			http.Error(w, "missing url param", http.StatusBadRequest)
			return
		}

		// Ugoira zips are multi-MB: on the Pi the fetch+write can exceed
		// the server's 15s WriteTimeout, killing the response mid-stream
		// (observed live: failures pinned at exactly 15.0s). The image
		// path gets its own bounded deadline — the tarpit pattern:
		// ResponseController overrides the global for this response only.
		// Set here for the CACHE-HIT path, and again after the slot
		// acquire for misses: time spent QUEUED must not eat the 120s
		// transfer budget.
		if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(120 * time.Second)); err != nil {
			log.Printf("WARNING img write deadline: %v", err)
		}

		// Check cache first
		if data, ct, ok := cache.get(imgURL); ok {
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Cache-Control", "public, max-age=86400")
			w.Header().Set("X-Cache", "HIT")
			w.Write(data)
			return
		}

		// Concurrency bound with a QUEUE (see imgFetchSlots above): waiters
		// block for a free slot instead of failing fast. The client's own
		// disconnect cancels the wait. Overflow past the waiter cap still
		// answers 429 + Retry-After.
		acquired := false
		select {
		case imgFetchSlots <- struct{}{}:
			acquired = true
		default:
		}
		if !acquired {
			if imgQueueWaiters.Add(1) > maxImgQueueWaiters {
				imgQueueWaiters.Add(-1)
				w.Header().Set("Retry-After", "1")
				http.Error(w, "image fetch saturated", http.StatusTooManyRequests)
				return
			}
			select {
			case imgFetchSlots <- struct{}{}:
			case <-r.Context().Done():
				imgQueueWaiters.Add(-1)
				return
			}
			imgQueueWaiters.Add(-1)
		}
		defer func() { <-imgFetchSlots }()

		if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(120 * time.Second)); err != nil {
			log.Printf("WARNING img write deadline: %v", err)
		}

		body, contentType, err := api.ProxyImageStream(imgURL, w)
		if err != nil {
			if errors.Is(err, pixiv.ErrStreamCommitted) {
				// The response already started (headers + bytes out):
				// http.Error would only append garbage to a committed
				// body. Log and let the client see the truncated stream.
				log.Printf("WARNING img stream interrupted: %v", err)
				return
			}
			log.Printf("ERROR img proxy: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		if body != nil {
			// Small body — cacheable. Oversized responses were already
			// streamed to w (with their headers) by the client.
			cache.set(imgURL, body, contentType)
			w.Header().Set("Content-Type", contentType)
			w.Header().Set("Cache-Control", "public, max-age=86400")
			w.Header().Set("X-Cache", "MISS")
			w.Write(body)
		}
	})

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	// Unmatched /api/* paths: JSON 404, never an SPA/HTML fallback.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":"not found"}`))
	})

	registerAuthProxy(mux, api, pkce)
}

// newServerBase builds the route mux WITHOUT the API-key gate, so prod
// can register extra routes (prefs DB) inside the gate. Tests keep
// using newServer (gate included) — behaviour unchanged.
func newServerBase(api pixivAPI, cache *imageCache) *http.ServeMux {
	mux := http.NewServeMux()
	buildRoutes(mux, api, cache)
	return mux
}

// registerPrefs wires the user-preference endpoints onto the mux.
// Called from main() inside the key gate; prefs tests call it directly
// against newServerBase with an in-memory DB.
func registerPrefs(mux *http.ServeMux, store *prefsStore) {
	const maxTags = 200
	const maxTagLen = 64

	mux.HandleFunc("/api/prefs/blocked-tags", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			tags, err := store.GetBlockedTags()
			if err != nil {
				log.Printf("ERROR prefs get: %v", err)
				http.Error(w, "prefs unavailable", http.StatusInternalServerError)
				return
			}
			writeJSON(w, map[string]any{"tags": tags})

		case http.MethodPut:
			var body struct {
				Tags []string `json:"tags"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil {
				http.Error(w, "invalid body", http.StatusBadRequest)
				return
			}
			if len(body.Tags) > maxTags {
				http.Error(w, "too many tags", http.StatusBadRequest)
				return
			}
			clean := make([]string, 0, len(body.Tags))
			seen := make(map[string]bool, len(body.Tags))
			for _, t := range body.Tags {
				t = strings.ToLower(strings.TrimSpace(t))
				if t == "" || len(t) > maxTagLen || seen[t] {
					continue
				}
				seen[t] = true
				clean = append(clean, t)
			}
			if err := store.SetBlockedTags(clean); err != nil {
				log.Printf("ERROR prefs set: %v", err)
				http.Error(w, "prefs unavailable", http.StatusInternalServerError)
				return
			}
			writeJSON(w, map[string]any{"tags": clean})

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	// Prefs routes share ONE shape (image-size + the two view modes):
	// GET returns {"value": v}; PUT validates a whitelist in the
	// HANDLER (400 for bad values) and maps any store error to a logged
	// 500 — a DB failure must never masquerade as a client error (that
	// conflation shipped once: the view-mode PUT reported "invalid view
	// mode" for a disk error, unlogged).
	registerPrefRoute := func(path, errLabel string, get func() (string, error), set func(string) error, allowed ...string) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			switch r.Method {
			case http.MethodGet:
				v, err := get()
				if err != nil {
					log.Printf("ERROR prefs %s get: %v", path, err)
					http.Error(w, "prefs unavailable", http.StatusInternalServerError)
					return
				}
				writeJSON(w, map[string]any{"value": v})

			case http.MethodPut:
				var body struct {
					Value string `json:"value"`
				}
				if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
					http.Error(w, "invalid body", http.StatusBadRequest)
					return
				}
				v := strings.TrimSpace(body.Value)
				ok := false
				for _, a := range allowed {
					if v == a {
						ok = true
						break
					}
				}
				if !ok {
					http.Error(w, "invalid "+errLabel, http.StatusBadRequest)
					return
				}
				if err := set(v); err != nil {
					log.Printf("ERROR prefs %s set: %v", path, err)
					http.Error(w, "prefs unavailable", http.StatusInternalServerError)
					return
				}
				writeJSON(w, map[string]any{"value": v})

			default:
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			}
		})
	}
	registerPrefRoute("/api/prefs/image-size", "image size", store.GetImageSize, store.SetImageSize, "large", "medium")
	registerPrefRoute("/api/prefs/feed-view-mode", "view mode", store.GetFeedViewMode, store.SetFeedViewMode, "strip", "grid")
	registerPrefRoute("/api/prefs/artist-view-mode", "view mode", store.GetArtistViewMode, store.SetArtistViewMode, "strip", "grid")
}

// apiKeyGate requires the shared key (set in .env as PIXTOK_API_KEY) on
// every /api route when configured. The Vite dev proxy injects the header
// server-side, so the browser never sees it — direct requests (malicious
// web pages posting to localhost, LAN peers) get 401. /health stays open.
// FAIL-CLOSED (reviewer finding): with no key configured the gate 401s
// everything instead of silently passing — a deployment mistake must be
// loud, not open.
func apiKeyGate(key string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" ||
			(key != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Api-Key")), []byte(key)) == 1) {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}
