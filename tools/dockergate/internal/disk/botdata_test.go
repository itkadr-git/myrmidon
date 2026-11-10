package disk

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// The data directory of the decommission route A22 (OPE-12654).

const (
	bdKey   = "0a1b2c3d-1111-2222-3333-444455556666"
	bdOther = "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff"
)

func bdWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func bdExists(t *testing.T, path string) bool {
	t.Helper()
	_, err := os.Lstat(path)
	if err == nil {
		return true
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	return false
}

func TestBotDataDirIsTheDirectChildOfTheResolvedRoot(t *testing.T) {
	volumeRoot := t.TempDir()
	resolved, err := filepath.EvalSymlinks(volumeRoot)
	if err != nil {
		t.Fatal(err)
	}
	dir, err := BotDataDir(volumeRoot, bdKey)
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(resolved, bdKey) {
		t.Fatalf("dir %q, want %q", dir, filepath.Join(resolved, bdKey))
	}
	// A trailing separator or a "." segment in the configured root changes nothing.
	if again, err := BotDataDir(volumeRoot+"/./", bdKey); err != nil || again != dir {
		t.Fatalf("cleaned root: %q %v", again, err)
	}
}

// No key can name anything but one direct child of the root: every key that is
// not a lowercase UUID is refused before the file system is looked at.
func TestBotDataDirRefusesEveryKeyThatIsNotABotKey(t *testing.T) {
	volumeRoot := t.TempDir()
	outside := t.TempDir()
	keep := filepath.Join(outside, "keep")
	bdWrite(t, keep, "x")
	bdWrite(t, filepath.Join(volumeRoot, bdKey, "hermes", "state.json"), "{}")
	for _, key := range []string{
		"", ".", "..", "/", "../" + bdKey, bdKey + "/..", bdKey + "/hermes", "/etc",
		"..%2F" + bdKey, "../" + filepath.Base(outside), strings.ToUpper(bdKey), bdKey + "\x00",
		" " + bdKey, bdKey + " ", ".scopes", "shared", bdKey[:35], bdKey + "0",
	} {
		if dir, err := BotDataDir(volumeRoot, key); !errors.Is(err, ErrBadKey) {
			t.Errorf("BotDataDir(%q) = %q, %v; want ErrBadKey", key, dir, err)
		}
		if removed, err := RemoveBotData(volumeRoot, key); removed || !errors.Is(err, ErrBadKey) {
			t.Errorf("RemoveBotData(%q) = %v, %v; want ErrBadKey", key, removed, err)
		}
	}
	if !bdExists(t, keep) || !bdExists(t, filepath.Join(volumeRoot, bdKey, "hermes", "state.json")) {
		t.Fatal("a refused key removed something")
	}
}

func TestBotDataDirNeedsAnAbsoluteRootThatResolves(t *testing.T) {
	for _, volumeRoot := range []string{"", "srv/myrmidon-bots", "./bots", filepath.Join(t.TempDir(), "missing")} {
		if dir, err := BotDataDir(volumeRoot, bdKey); !errors.Is(err, ErrBotDataRoot) {
			t.Errorf("BotDataDir(%q) = %q, %v; want ErrBotDataRoot", volumeRoot, dir, err)
		}
	}
}

func TestRemoveBotDataRemovesTheBotTreeAndNothingElse(t *testing.T) {
	volumeRoot := t.TempDir()
	outside := t.TempDir()
	keepOutside := filepath.Join(outside, "keep")
	bdWrite(t, keepOutside, "outside")
	dir := filepath.Join(volumeRoot, bdKey)
	bdWrite(t, filepath.Join(dir, "hermes", "sessions", "s1.json"), "{}")
	bdWrite(t, filepath.Join(dir, "workspace", "repo", ".git", "HEAD"), "ref: refs/heads/main\n")
	bdWrite(t, filepath.Join(dir, "scratch", "tmp.txt"), "x")
	// A link inside the bot's tree that points outside it: removed as a link, never followed.
	if err := os.Symlink(outside, filepath.Join(dir, "workspace", "escape")); err != nil {
		t.Fatal(err)
	}
	sibling := filepath.Join(volumeRoot, bdOther, "hermes", "config.yaml")
	bdWrite(t, sibling, "model: x\n")

	removed, err := RemoveBotData(volumeRoot, bdKey)
	if err != nil || !removed {
		t.Fatalf("RemoveBotData = %v, %v", removed, err)
	}
	if bdExists(t, dir) {
		t.Fatal("the bot data directory is still there")
	}
	if !bdExists(t, sibling) {
		t.Fatal("another bot's data was removed")
	}
	if !bdExists(t, keepOutside) {
		t.Fatal("a file outside the volume root was removed through a link")
	}
	if !bdExists(t, volumeRoot) {
		t.Fatal("the volume root itself was removed")
	}

	// Nothing left: a second removal is a no-op, not an error.
	removed, err = RemoveBotData(volumeRoot, bdKey)
	if err != nil || removed {
		t.Fatalf("second RemoveBotData = %v, %v; want false, nil", removed, err)
	}
}

func TestRemoveBotDataRefusesALinkInPlaceOfTheDirectory(t *testing.T) {
	volumeRoot := t.TempDir()
	target := t.TempDir()
	keep := filepath.Join(target, "keep")
	bdWrite(t, keep, "x")
	link := filepath.Join(volumeRoot, bdKey)
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	removed, err := RemoveBotData(volumeRoot, bdKey)
	if removed || !errors.Is(err, ErrBotDataNotDir) {
		t.Fatalf("RemoveBotData over a link = %v, %v; want ErrBotDataNotDir", removed, err)
	}
	if !bdExists(t, keep) || !bdExists(t, link) {
		t.Fatal("the link or its target was touched")
	}
}

func TestRemoveBotDataRefusesAFileInPlaceOfTheDirectory(t *testing.T) {
	volumeRoot := t.TempDir()
	bdWrite(t, filepath.Join(volumeRoot, bdKey), "not a directory")
	if removed, err := RemoveBotData(volumeRoot, bdKey); removed || !errors.Is(err, ErrBotDataNotDir) {
		t.Fatalf("RemoveBotData over a file = %v, %v; want ErrBotDataNotDir", removed, err)
	}
}

// The gate runs unprivileged: a directory it may not delete in is a failure it
// reports, with the reason in the fixed vocabulary of the log.
func TestRemoveBotDataReportsAPermissionFailure(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root deletes regardless of the mode bits")
	}
	volumeRoot := t.TempDir()
	bdWrite(t, filepath.Join(volumeRoot, bdKey, "hermes", "state.json"), "{}")
	if err := os.Chmod(volumeRoot, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(volumeRoot, 0o755) })
	removed, err := RemoveBotData(volumeRoot, bdKey)
	if removed || err == nil {
		t.Fatalf("RemoveBotData under a read-only parent = %v, %v; want an error", removed, err)
	}
	if got := BotDataFailure(err); got != "permission" {
		t.Fatalf("BotDataFailure = %q, want permission (err %v)", got, err)
	}
}

func TestBotDataFailureVocabulary(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{ErrBadKey, "bad_key"},
		{ErrBotDataRoot, "volume_root"},
		{ErrBotDataNotDir, "not_a_directory"},
		{&fs.PathError{Op: "unlinkat", Path: "/srv/myrmidon-bots/x", Err: syscall.EROFS}, "read_only"},
		{&fs.PathError{Op: "unlinkat", Path: "/srv/myrmidon-bots/x", Err: syscall.EACCES}, "permission"},
		{&fs.PathError{Op: "unlinkat", Path: "/srv/myrmidon-bots/x", Err: syscall.EPERM}, "permission"},
		{errors.New("something else"), "remove"},
	} {
		if got := BotDataFailure(tc.err); got != tc.want {
			t.Errorf("BotDataFailure(%v) = %q, want %q", tc.err, got, tc.want)
		}
	}
}
