package pixiv

// One .env resolver (review finding M5). Reads must not stop at the first
// EXISTING file (a file without the key does not shadow a later one), and
// writes must land in the file that actually supplies the key — otherwise
// a rotation can be written to a file nothing ever reads.

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadEnvKeyFromSkipsFilesWithoutTheKey(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first.env")
	second := filepath.Join(dir, "second.env")
	if err := os.WriteFile(first, []byte("PIXTOK_CACHE_TTL=1h\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("PIXTOK_TEST_ONLY_KEY=from-second\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := readEnvKeyFrom([]string{first, second}, "PIXTOK_TEST_ONLY_KEY"); got != "from-second" {
		t.Fatalf("readEnvKeyFrom = %q, want from-second (first existing file must not shadow a later key)", got)
	}
	if got := readEnvKeyFrom([]string{first, second}, "PIXTOK_TEST_ONLY_ABSENT"); got != "" {
		t.Fatalf("absent key = %q, want empty", got)
	}
}

func TestReadEnvKeyEnvironmentWins(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pinned.env")
	if err := os.WriteFile(path, []byte("PIXTOK_TEST_ONLY_KEY=from-file\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIXTOK_TEST_ONLY_KEY", "from-env")
	if got := readEnvKeyFrom([]string{path}, "PIXTOK_TEST_ONLY_KEY"); got != "from-env" {
		t.Fatalf("environment did not win: %q", got)
	}
}

func TestEnvFileForWritePrefersTheFileHoldingTheKey(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first.env")
	second := filepath.Join(dir, "second.env")
	if err := os.WriteFile(first, []byte("OTHER=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(second, []byte("PIXTOK_TEST_ONLY_KEY=old\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := envFileForWrite([]string{first, second}, []string{"PIXTOK_TEST_ONLY_KEY"}); got != second {
		t.Fatalf("write target = %q, want the file that supplies the key (%q)", got, second)
	}
}

func TestEnvFileForWriteFallsBackToFirstExistingThenCreateTarget(t *testing.T) {
	dir := t.TempDir()
	first := filepath.Join(dir, "first.env")
	second := filepath.Join(dir, "second.env")
	if err := os.WriteFile(second, []byte("OTHER=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Neither file holds the key: the first EXISTING candidate wins.
	if got := envFileForWrite([]string{first, second}, []string{"PIXTOK_TEST_ONLY_KEY"}); got != second {
		t.Fatalf("write target = %q, want first existing %q", got, second)
	}
	// Nothing exists: the first candidate is the create target.
	missing := filepath.Join(dir, "fresh.env")
	if got := envFileForWrite([]string{missing}, []string{"PIXTOK_TEST_ONLY_KEY"}); got != missing {
		t.Fatalf("create target = %q, want %q", got, missing)
	}
}

// EnvCandidates must be the single source of truth: PIXTOK_ENV_FILE pins
// exactly one path, otherwise the list is ordered and non-empty.
func TestEnvCandidates(t *testing.T) {
	pinned := filepath.Join(t.TempDir(), "pinned.env")
	t.Setenv("PIXTOK_ENV_FILE", pinned)
	got := EnvCandidates()
	if len(got) != 1 || got[0] != pinned {
		t.Fatalf("EnvCandidates with a pinned file = %v, want [%s]", got, pinned)
	}
}
