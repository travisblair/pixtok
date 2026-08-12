package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
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
	GetBookmarkIllusts(restrict string) ([]byte, error)
	SearchArtworks(word string, opts pixiv.SearchOpts, page int) ([]byte, error)
	SearchUsers(nick, sMode string, page int) ([]byte, error)
	ProxyNext(nextURL string) ([]byte, error)
	ProxyImage(imgURL string) ([]byte, string, error)
	// ── login capture (the /api/auth/* protocol) ──
	ExchangePkce(code, verifier string) (refresh, access string, expiresIn int, err error)
	SetTokens(refresh, access string, expiresIn int) error
	SetWebSession(phpsessid, csrfToken string) error
	ScrapeCsrfFor(phpsessid string) (string, error)
	AuthHealth() (appOK bool, webOK bool)
}

// pkceStore holds in-flight PKCE challenges: single-use, short-TTL,
// capped. The login shim gets a state from /pkce/begin and returns it
// with the OAuth code at /pkce/complete.
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
	// Shed stale entries; if still full, drop the oldest arbitrary one.
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

var phpsessidRe = regexp.MustCompile(`^[0-9]+_[0-9a-fA-F]{16,}$`)

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

	// ── Login capture (the /api/auth/* protocol). All POST-only, all
	// behind the API-key gate below; the login shim (Node, any OS) is
	// the only caller. Credentials never touch these endpoints — only
	// one-time OAuth codes and cookies the shim captured. ────────────

	mux.HandleFunc("/api/auth/pkce/begin", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		verifier, err := randomB64(32)
		if err != nil {
			http.Error(w, "rng failure", http.StatusInternalServerError)
			return
		}
		sum := sha256.Sum256([]byte(verifier))
		challenge := base64.RawURLEncoding.EncodeToString(sum[:])
		state, err := randomB64(16)
		if err != nil {
			http.Error(w, "rng failure", http.StatusInternalServerError)
			return
		}
		pkce.put(state, verifier)
		loginURL := fmt.Sprintf(
			"https://app-api.pixiv.net/web/v1/login?code_challenge=%s&code_challenge_method=S256&client=pixiv-android",
			challenge,
		)
		writeJSON(w, map[string]string{"login_url": loginURL, "state": state})
	})

	mux.HandleFunc("/api/auth/pkce/complete", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Code  string `json:"code"`
			State string `json:"state"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if req.Code == "" || req.State == "" {
			http.Error(w, "code and state required", http.StatusBadRequest)
			return
		}
		verifier, ok := pkce.take(req.State)
		if !ok {
			http.Error(w, "unknown or expired state", http.StatusBadRequest)
			return
		}
		refreshTok, accessTok, expiresIn, err := api.ExchangePkce(req.Code, verifier)
		if err != nil {
			log.Printf("ERROR pkce exchange: %v", err)
			http.Error(w, "pkce exchange failed", http.StatusBadGateway)
			return
		}
		if err := api.SetTokens(refreshTok, accessTok, expiresIn); err != nil {
			log.Printf("ERROR persisting tokens: %v", err)
			http.Error(w, "persist failed", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	})

	mux.HandleFunc("/api/auth/session", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Phpsessid string `json:"phpsessid"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&req); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if !phpsessidRe.MatchString(req.Phpsessid) {
			http.Error(w, "invalid phpsessid format", http.StatusBadRequest)
			return
		}
		csrf, err := api.ScrapeCsrfFor(req.Phpsessid)
		if err != nil {
			log.Printf("ERROR csrf scrape: %v", err)
			http.Error(w, "session validation failed", http.StatusBadGateway)
			return
		}
		if err := api.SetWebSession(req.Phpsessid, csrf); err != nil {
			log.Printf("ERROR persisting session: %v", err)
			http.Error(w, "persist failed", http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	})

	mux.HandleFunc("/api/auth/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		appOK, webOK := api.AuthHealth()
		writeJSON(w, map[string]bool{"app_api": appOK, "web_session": webOK})
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
		if lastID != "" && !validNumericID(lastID) {
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
		if !validNumericID(id) {
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
			if err != nil || n < 1 || n > 25 {
				http.Error(w, "invalid pages", http.StatusBadRequest)
				return
			}
			pages = n
		}
		// Both visibility pools: pixtok likes are private; the site's
		// heart makes public ones. Merge so hearts are right either way.
		privateIDs, err := api.GetBookmarkIDs("private", pages)
		if err != nil {
			log.Printf("ERROR bookmark ids (private): %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		publicIDs, err := api.GetBookmarkIDs("public", pages)
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
		out, _ := json.Marshal(map[string]any{"ids": ids})
		w.Header().Set("Content-Type", "application/json")
		w.Write(out)
	})

	// ── Search (the site's search pages: tag/free-text artworks + users) ──

	// Bookmarks tab feed: the user's bookmarked works (private by
	// default — pixtok likes are private). Standard app-API passthrough;
	// pagination rides the existing /api/next route.
	mux.HandleFunc("GET /api/bookmarks", func(w http.ResponseWriter, r *http.Request) {
		restrict := r.URL.Query().Get("restrict")
		if restrict == "" {
			restrict = "private"
		}
		body, err := api.GetBookmarkIllusts(restrict)
		if err != nil {
			log.Printf("ERROR bookmarks: %v", err)
			if errors.Is(err, pixiv.ErrInvalidParam) {
				http.Error(w, "invalid parameter", http.StatusBadRequest)
				return
			}
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
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
		out, _ := json.Marshal(resp)
		w.Header().Set("Content-Type", "application/json")
		w.Write(out)
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
		out, _ := json.Marshal(resp)
		w.Header().Set("Content-Type", "application/json")
		w.Write(out)
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
			if !validNumericID(id) {
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
			if !validNumericID(id) {
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
			if !validNumericID(id) {
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
			if !validNumericID(id) {
				http.Error(w, "invalid illust id", http.StatusBadRequest)
				return
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
			if !validNumericID(id) {
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

		// Check cache first
		if data, ct, ok := cache.get(imgURL); ok {
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Cache-Control", "public, max-age=86400")
			w.Header().Set("X-Cache", "HIT")
			w.Write(data)
			return
		}

		body, contentType, err := api.ProxyImage(imgURL)
		if err != nil {
			log.Printf("ERROR img proxy: %v", err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}

		cache.set(imgURL, body, contentType)

		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Header().Set("X-Cache", "MISS")
		w.Write(body)
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
			out, _ := json.Marshal(map[string]any{"tags": tags})
			w.Header().Set("Content-Type", "application/json")
			w.Write(out)

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
			out, _ := json.Marshal(map[string]any{"tags": clean})
			w.Header().Set("Content-Type", "application/json")
			w.Write(out)

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/api/prefs/image-size", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			v, err := store.GetImageSize()
			if err != nil {
				log.Printf("ERROR prefs image-size get: %v", err)
				http.Error(w, "prefs unavailable", http.StatusInternalServerError)
				return
			}
			out, _ := json.Marshal(map[string]any{"value": v})
			w.Header().Set("Content-Type", "application/json")
			w.Write(out)

		case http.MethodPut:
			var body struct {
				Value string `json:"value"`
			}
			if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
				http.Error(w, "invalid body", http.StatusBadRequest)
				return
			}
			if body.Value != "large" && body.Value != "medium" {
				http.Error(w, "invalid image size", http.StatusBadRequest)
				return
			}
			if err := store.SetImageSize(body.Value); err != nil {
				log.Printf("ERROR prefs image-size set: %v", err)
				http.Error(w, "prefs unavailable", http.StatusInternalServerError)
				return
			}
			out, _ := json.Marshal(map[string]any{"value": body.Value})
			w.Header().Set("Content-Type", "application/json")
			w.Write(out)

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

// validNumericID reports whether s is a non-empty all-digits string.
// Handler-level guard so client input errors map to 400, not a 502
// from the upstream client.
func validNumericID(s string) bool {
	if s == "" {
		return false
	}
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

// apiKeyGate requires the shared key (set in .env as PIXTOK_API_KEY) on
// every /api route when configured. The Vite dev proxy injects the header
// server-side, so the browser never sees it — direct requests (malicious
// web pages posting to localhost, LAN peers) get 401. /health stays open.
func apiKeyGate(key string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if key == "" || r.URL.Path == "/health" ||
			subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Api-Key")), []byte(key)) == 1 {
			next.ServeHTTP(w, r)
			return
		}
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}
