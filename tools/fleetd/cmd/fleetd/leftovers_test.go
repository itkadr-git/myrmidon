package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// Everything here is placeholder data: fake bot keys.

func TestLeftoverTime(t *testing.T) {
	stamp := time.Date(2026, 11, 1, 2, 3, 4, 5, time.UTC)
	replaced := fmt.Sprintf(".replaced-bot-example-one-%d", stamp.UnixNano())
	if got, ok := leftoverTime(replaced); !ok || !got.Equal(stamp) {
		t.Errorf("leftoverTime(%q) = %v, %v", replaced, got, ok)
	}
	quarantined := fmt.Sprintf(".quarantined-bot-example-one-%d", stamp.Unix())
	if got, ok := leftoverTime(quarantined); !ok || !got.Equal(stamp.Truncate(time.Second)) {
		t.Errorf("leftoverTime(%q) = %v, %v", quarantined, got, ok)
	}
	for _, name := range []string{
		"bot-example-one",
		".restore-bot-example-one-1730000000000000000",
		".replaced-bot-example-one-soon",
		".replaced-bot-example-one-",
		".replaced-bot-example-one-0",
		".replaced-1730000000000000000",
		".quarantined-",
		".replaced-",
		"",
	} {
		if got, ok := leftoverTime(name); ok {
			t.Errorf("leftoverTime(%q) = %v, want no time", name, got)
		}
	}
}

func TestStaleLeftoversPicksOnlyOldDatedDirectories(t *testing.T) {
	root := t.TempDir()
	now := time.Date(2026, 11, 8, 3, 0, 0, 0, time.UTC)
	old := now.Add(-8 * 24 * time.Hour)
	fresh := now.Add(-6 * 24 * time.Hour)
	mkdir := func(name string) {
		t.Helper()
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	oldReplaced := fmt.Sprintf(".replaced-bot-example-one-%d", old.UnixNano())
	oldQuarantined := fmt.Sprintf(".quarantined-bot-example-two-%d", old.Unix())
	mkdir(oldReplaced)
	mkdir(oldQuarantined)
	mkdir(fmt.Sprintf(".replaced-bot-example-one-%d", fresh.UnixNano()))
	mkdir(fmt.Sprintf(".quarantined-bot-example-two-%d", fresh.Unix()))
	mkdir("bot-example-one")
	mkdir(".replaced-bot-example-one-notatime")
	mkdir(fmt.Sprintf(".restore-bot-example-one-%d", old.UnixNano()))

	// A file and a symlink with an old name are not directories of ours.
	fileName := fmt.Sprintf(".replaced-bot-example-three-%d", old.UnixNano())
	if err := os.WriteFile(filepath.Join(root, fileName), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	linkName := fmt.Sprintf(".quarantined-bot-example-three-%d", old.Unix())
	if err := os.Symlink("bot-example-one", filepath.Join(root, linkName)); err != nil {
		t.Fatal(err)
	}

	stale, err := staleLeftovers(root, now, leftoverMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{filepath.Join(root, oldQuarantined), filepath.Join(root, oldReplaced)}
	sort.Strings(stale)
	if fmt.Sprint(stale) != fmt.Sprint(want) {
		t.Fatalf("stale = %v, want %v", stale, want)
	}
}

func TestLeftoverRetentionIsSevenDays(t *testing.T) {
	if leftoverMaxAge != 7*24*time.Hour {
		t.Fatalf("leftoverMaxAge = %v", leftoverMaxAge)
	}
	root := t.TempDir()
	now := time.Date(2026, 11, 8, 3, 0, 0, 0, time.UTC)
	atLimit := now.Add(-leftoverMaxAge)
	justOver := atLimit.Add(-time.Second)
	atLimitName := fmt.Sprintf(".quarantined-bot-example-one-%d", atLimit.Unix())
	justOverName := fmt.Sprintf(".quarantined-bot-example-two-%d", justOver.Unix())
	for _, name := range []string{atLimitName, justOverName} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	stale, err := staleLeftovers(root, now, leftoverMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	if len(stale) != 1 || filepath.Base(stale[0]) != justOverName {
		t.Fatalf("only a directory older than 7 days is stale, got %v", stale)
	}
}

func TestCleanupLeftoversRemovesStaleDirectoriesWithTheirContent(t *testing.T) {
	root := t.TempDir()
	now := time.Date(2026, 11, 8, 3, 0, 0, 0, time.UTC)
	old := now.Add(-9 * 24 * time.Hour)
	fresh := now.Add(-time.Hour)
	oldDir := filepath.Join(root, fmt.Sprintf(".replaced-bot-example-one-%d", old.UnixNano()))
	freshDir := filepath.Join(root, fmt.Sprintf(".replaced-bot-example-one-%d", fresh.UnixNano()))
	live := filepath.Join(root, "bot-example-one")
	for _, dir := range []string{oldDir, freshDir, live} {
		if err := os.MkdirAll(filepath.Join(dir, "hermes"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "hermes", "session.db"), []byte("data"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := cleanupLeftovers(root, now, leftoverMaxAge)
	if err != nil || removed != 1 {
		t.Fatalf("cleanupLeftovers = %d, %v; want 1, nil", removed, err)
	}
	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Fatalf("the stale directory is still there: %v", err)
	}
	for _, kept := range []string{freshDir, live} {
		if _, err := os.Stat(filepath.Join(kept, "hermes", "session.db")); err != nil {
			t.Fatalf("%s must stay: %v", filepath.Base(kept), err)
		}
	}
	missing := filepath.Join(root, "no-such-root")
	if removed, err := cleanupLeftovers(missing, now, leftoverMaxAge); err != nil || removed != 0 {
		t.Fatalf("a missing volume root is not an error: %d, %v", removed, err)
	}
}

// The sweep reads the names that restore and quarantine write, so it has to
// recognise exactly what the two handlers create.
func TestSweepRecognisesWhatRestoreAndQuarantineCreate(t *testing.T) {
	_, key, archive := snapshotOf(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, key), 0755); err != nil {
		t.Fatal(err)
	}
	if rec := restoreInto(t, root, key, archive); rec.Code != http.StatusOK {
		t.Fatalf("restore failed: %d %s", rec.Code, rec.Body.String())
	}
	target, _ := newServer(t)
	target.cfg.VolumeRoot = root
	if rec := routeRequest(target, http.MethodPost, "/v1/bots/"+key+"/quarantine", target.cfg.Token, ""); rec.Code != http.StatusOK {
		t.Fatalf("quarantine failed: %d %s", rec.Code, rec.Body.String())
	}

	now := time.Now()
	if stale, err := staleLeftovers(root, now, leftoverMaxAge); err != nil || len(stale) != 0 {
		t.Fatalf("fresh leftovers are stale: %v %v", stale, err)
	}
	later := now.Add(leftoverMaxAge + time.Hour)
	stale, err := staleLeftovers(root, later, leftoverMaxAge)
	if err != nil || len(stale) != 2 {
		t.Fatalf("expected the replaced and the quarantined directory, got %v %v", stale, err)
	}
	if removed, err := cleanupLeftovers(root, later, leftoverMaxAge); err != nil || removed != 2 {
		t.Fatalf("cleanupLeftovers = %d, %v; want 2, nil", removed, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the volume root is not empty after the sweep: %d entries", len(entries))
	}
}
