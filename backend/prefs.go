package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

// ── User prefs store ──────────────────────────────────────────────────
//
// Client-side localStorage proved unreliable for durable user state
// (iOS Safari evicts script-writable storage aggressively — blocked
// tags and liked-state vanished on the device). Preferences live here
// in a tiny key-value SQLite table owned by the backend. The DB is
// GORM + pure-Go glebarez/sqlite (same stack as freezer-app, no CGO).

// Pref is one key-value row.
type Pref struct {
	Key   string `gorm:"primaryKey"`
	Value string `gorm:"not null"`
}

type prefsStore struct {
	db *gorm.DB
}

// Close releases the underlying SQLite handle — called during graceful
// shutdown (reviewer finding: the connection was never explicitly
// closed).
func (s *prefsStore) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	sqlDB, err := s.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

const blockedTagsKey = "blocked_tags"

// openPrefs opens (and migrates) the prefs database at path. For tests
// pass ":memory:". The logger is silenced: prefs writes are routine.
func openPrefs(path string) (*prefsStore, error) {
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		return nil, fmt.Errorf("open prefs db: %w", err)
	}
	if path != ":memory:" {
		// Single-user state (reviewer finding): the db file sits next to
		// .env and should be as private as it — 0600, best-effort, a
		// read-only FS shouldn't kill prefs.
		if err := os.Chmod(path, 0o600); err != nil {
			log.Printf("WARNING: could not chmod 0600 %s: %v", path, err)
		}
	}
	if err := db.AutoMigrate(&Pref{}); err != nil {
		return nil, fmt.Errorf("migrate prefs db: %w", err)
	}
	return &prefsStore{db: db}, nil
}

func (s *prefsStore) get(key string) (string, error) {
	var p Pref
	if err := s.db.First(&p, "key = ?", key).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", nil
		}
		return "", err
	}
	return p.Value, nil
}

func (s *prefsStore) set(key, value string) error {
	// Upsert, not read-then-write: two concurrent PUTs racing through
	// First()+Create() could both see ErrRecordNotFound and collide on
	// the primary key. ON CONFLICT makes the write atomic.
	return s.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value"}),
	}).Create(&Pref{Key: key, Value: value}).Error
}

// GetBlockedTags returns the blocked tag list (empty when never set).
func (s *prefsStore) GetBlockedTags() ([]string, error) {
	raw, err := s.get(blockedTagsKey)
	if err != nil {
		return nil, err
	}
	if raw == "" {
		return []string{}, nil
	}
	var tags []string
	if err := json.Unmarshal([]byte(raw), &tags); err != nil {
		// Corrupt value — treat as empty rather than breaking the app.
		return []string{}, nil
	}
	return tags, nil
}

// SetBlockedTags replaces the blocked tag list wholesale (the FE owns
// the list and sends the full array on every change).
func (s *prefsStore) SetBlockedTags(tags []string) error {
	raw, err := json.Marshal(tags)
	if err != nil {
		return err
	}
	return s.set(blockedTagsKey, string(raw))
}

const imageSizeKey = "image_size"

// GetImageSize returns the image quality preference: "large" (default,
// master1200) or "medium" (540 where the feed carries it).
func (s *prefsStore) GetImageSize() (string, error) {
	v, err := s.get(imageSizeKey)
	if err != nil {
		return "", err
	}
	if v != "medium" {
		return "large", nil
	}
	return v, nil
}

func (s *prefsStore) SetImageSize(v string) error {
	if v != "large" && v != "medium" {
		return fmt.Errorf("invalid image size")
	}
	return s.set(imageSizeKey, v)
}

const feedViewModeKey = "feed_view_mode"
const artistViewModeKey = "artist_view_mode"

// viewMode reads a view-mode pref. Anything that isn't "grid" reads as
// the default "strip" — corrupt or legacy values degrade to the default
// rather than breaking rendering.
func (s *prefsStore) viewMode(key string) (string, error) {
	v, err := s.get(key)
	if err != nil {
		return "", err
	}
	if v != "grid" {
		return "strip", nil
	}
	return "grid", nil
}

// GetFeedViewMode returns how feed tabs render: "strip" (default,
// full-bleed 100dvh cards) or "grid" (square thumbnails).
func (s *prefsStore) GetFeedViewMode() (string, error) {
	return s.viewMode(feedViewModeKey)
}

func (s *prefsStore) SetFeedViewMode(v string) error {
	if v != "strip" && v != "grid" {
		return fmt.Errorf("invalid feed view mode")
	}
	return s.set(feedViewModeKey, v)
}

// GetArtistViewMode returns how the artist page library renders — same
// values as the feed toggle, but independent of it.
func (s *prefsStore) GetArtistViewMode() (string, error) {
	return s.viewMode(artistViewModeKey)
}

func (s *prefsStore) SetArtistViewMode(v string) error {
	if v != "strip" && v != "grid" {
		return fmt.Errorf("invalid artist view mode")
	}
	return s.set(artistViewModeKey, v)
}
