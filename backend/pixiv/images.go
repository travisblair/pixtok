package pixiv

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"time"
)

// Image/CDN proxy: the pixiv CDN allowlist and the /api/img streaming
// relay (buffered under the cache ceiling, streamed above it).
var imageHosts = map[string]bool{
	"i.pximg.net":                true,
	"img.pximg.net":              true,
	"s.pximg.net":                true,
	"img-zip-ugoira.i.pximg.net": true, // ugoira frame archives (zip)
}

// validImageURL enforces the allowlist for the /api/img proxy:
// only Pixiv image CDN hosts, https only, default port, and NO userinfo
// or fragments (reviewer note: userinfo and fragments have no place in
// the CDN URL grammar and are classic embedding tricks).
func validImageURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || !imageHosts[u.Hostname()] {
		return false
	}
	if u.User != nil || u.Fragment != "" {
		return false
	}
	port := u.Port()
	return port == "" || port == "443"
}

// imageClientTimeout is the slow-path ceiling for image/zip relays
// (multi-MB ugoira zips over a weak radio). Feeds stay on clientTimeout.
const imageClientTimeout = 120 * time.Second

// ErrStreamCommitted marks an image-proxy failure that happened AFTER
// the response had already started (headers + bytes flushed to the
// client). The caller must log, not http.Error — a status write to a
// committed response only appends garbage to a truncated body.
var ErrStreamCommitted = errors.New("image response already started")

// maxCacheableBody mirrors main.imageCache's maxEntryBytes: bodies at or
// under this size are buffered and handed back for caching; anything
// larger streams straight through. If the two constants drift, the worst
// case is a cache miss (memory stays bounded either way).
const maxCacheableBody = 5 << 20

// ProxyImageStream fetches one CDN image/zip and delivers it to w. Small
// responses (<= maxCacheableBody) are fully buffered and RETURNED so the
// caller can cache them — the caller writes the body and sets headers.
// Oversized responses stream directly to w (headers set here, since the
// first body byte must not precede them) and return a nil body — they
// are never cached. Error contract: on the SMALL-body path every error
// fires before any header or byte is written, so callers can still
// answer with a clean error status. On the STREAMING path a failure
// (client disconnect, slow Pi) can occur after the response already
// started — those errors wrap ErrStreamCommitted so the caller logs
// instead of http.Error-ing a committed response.
func (c *Client) ProxyImageStream(imgURL string, w http.ResponseWriter) ([]byte, string, error) {
	// img URLs come from the CLIENT — enforce the CDN allowlist so
	// /api/img can't be used as an open proxy into the LAN.
	if !validImageURL(imgURL) {
		return nil, "", fmt.Errorf("image host not allowed")
	}

	req, err := http.NewRequest("GET", imgURL, nil)
	if err != nil {
		return nil, "", err
	}

	req.Header.Set("Referer", "https://www.pixiv.net/")
	req.Header.Set("User-Agent", userAgent)

	// Images/zips are the slow path on the Pi Zero (multi-MB ugoira zips
	// over a weak radio): give the image client a longer ceiling than
	// the shared 30s client. Feeds stay strict; a stalled zip burns a
	// bounded 2 minutes, then dies.
	imgClient := c.newValidatedClient(validImageURL)
	imgClient.Timeout = imageClientTimeout
	resp, err := imgClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, "", fmt.Errorf("image proxy returned %d", resp.StatusCode)
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/jpeg"
	}
	// Content-type allowlist (reviewer finding): the upstream header is
	// echoed to the browser — trust it only for types this proxy exists
	// to serve. SVG especially must stay rejected or the image proxy
	// becomes a script-capable content proxy. application/zip covers
	// ugoira frame archives.
	if mt, _, err := mime.ParseMediaType(contentType); err == nil {
		contentType = mt
	}
	switch contentType {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "application/zip":
	default:
		return nil, "", fmt.Errorf("image proxy returned disallowed content type %q", contentType)
	}

	// Buffer only up to the cache ceiling (reviewer finding): a burst of
	// cache misses used to allocate up to 25 MB each — on the Pi's
	// memory budget that's an OOM vector. Bodies over the ceiling stream
	// straight through under the same 25 MB cap and are never cached.
	//
	// Size the buffer from ContentLength when upstream declares it
	// (review finding): the old code allocated the FULL 5 MB ceiling per
	// miss even for a 100 KB thumbnail — 8 concurrent semaphore slots ×
	// 5 MB of transient garbage on a GOMEMLIMIT=80MiB Pi during exactly
	// the grid-burst scenario the semaphore exists to handle. Unknown
	// lengths (chunked, -1) fall back to the ceiling-sized buffer.
	bufSize := int64(maxCacheableBody + 1)
	if cl := resp.ContentLength; cl > 0 && cl < bufSize {
		bufSize = cl + 1 // +1 so a body AT the ceiling still detects overflow
	}
	head := make([]byte, bufSize)
	n, err := io.ReadFull(resp.Body, head)
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		return head[:n], contentType, nil
	}
	if err != nil {
		return nil, "", fmt.Errorf("read image body: %w", err)
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("X-Cache", "MISS")
	if _, err := w.Write(head); err != nil {
		return nil, "", fmt.Errorf("%w: write image body: %v", ErrStreamCommitted, err)
	}
	remaining := int64(maxImageBody - maxCacheableBody - 1)
	if remaining < 0 {
		remaining = 0
	}
	if _, err := io.Copy(w, io.LimitReader(resp.Body, remaining)); err != nil {
		return nil, "", fmt.Errorf("%w: stream image body: %v", ErrStreamCommitted, err)
	}
	return nil, contentType, nil
}
