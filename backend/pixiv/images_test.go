package pixiv

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Regression (review 1017-1 F-17): for a response with no ContentLength
// the buffer is sized at the full 5 MiB cache ceiling. Returning
// head[:n] kept that whole backing array alive in the image cache, which
// accounts len() — so a 100 KB thumbnail pinned 5 MiB (x300 entries =
// 1.5 GiB on a GOMEMLIMIT=80MiB Pi).
func TestProxyImageStreamDoesNotPinTheCeilingBuffer(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), 100<<10)
	rt := &staticBodyTransport{body: payload, ct: "image/jpeg", contentLen: -1}
	c := &Client{http: &http.Client{Transport: rt}}

	data, contentType, err := c.ProxyImageStream("https://i.pximg.net/img/x.jpg", httptest.NewRecorder())
	if err != nil {
		t.Fatalf("ProxyImageStream: %v", err)
	}
	if contentType != "image/jpeg" {
		t.Fatalf("content type = %q", contentType)
	}
	if len(data) != len(payload) {
		t.Fatalf("body length = %d, want %d", len(data), len(payload))
	}
	if cap(data) != len(data) {
		t.Fatalf("buffered body cap = %d, len = %d — a %d-byte backing array rides along with every cache entry",
			cap(data), len(data), cap(data))
	}
}
