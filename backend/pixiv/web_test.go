package pixiv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A web-session swap whose .env write fails must leave the running
// client on the OLD session. Committing memory first (the old code) let
// the process run on a session disk had never seen; after a restart the
// resurrected, dead PHPSESSID broke every web-AJAX surface.
func TestSetWebSessionDoesNotSwapWhenPersistenceFails(t *testing.T) {
	// A directory at the env path makes the read/modify/write fail
	// before anything can be persisted.
	t.Setenv("PIXTOK_ENV_FILE", t.TempDir())

	c := &Client{}
	c.setWebCache("123456_old", "old-token")

	if err := c.SetWebSession("123456_new", "new-token"); err == nil {
		t.Fatal("SetWebSession succeeded with an unwritable .env")
	}
	if sess, tok := c.webSession(); sess != "123456_old" || tok != "old-token" {
		t.Fatalf("memory swapped to (%q, %q) despite a failed persist — memory is ahead of disk", sess, tok)
	}
}

func TestSetWebSessionPersistsBothKeys(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")
	t.Setenv("PIXTOK_ENV_FILE", envPath)

	c := &Client{}
	c.setWebCache("123456_old", "old-token")
	if err := c.SetWebSession("123456_new", "new-token"); err != nil {
		t.Fatalf("SetWebSession: %v", err)
	}
	if sess, tok := c.webSession(); sess != "123456_new" || tok != "new-token" {
		t.Fatalf("memory = (%q, %q), want the new session", sess, tok)
	}
	raw, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"PIXIV_PHPSESSID=123456_new", "PIXTOK_CSRF_TOKEN=new-token"} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf(".env missing %q:\n%s", want, raw)
		}
	}
}
