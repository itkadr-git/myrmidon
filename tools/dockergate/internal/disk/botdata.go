package disk

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
)

// The data directory of a bot (OPE-12654). The decommission route (A22) removes
// it once the bot's main container is gone: the board has no mount of the volume
// root, so the gate, which has one, is the only party that can.

// Errors of BotDataDir and RemoveBotData. Anything else is a failure of the host
// (a read-only mount, a directory the gate may not delete in) and is named by
// BotDataFailure.
var (
	// ErrBotDataRoot: the volume root is not an absolute path that resolves.
	ErrBotDataRoot = errors.New("disk: volume root unavailable")
	// ErrBotDataNotDir: <volumeRoot>/<botKey> is a link or not a directory.
	ErrBotDataNotDir = errors.New("disk: bot data path is not a real directory")
)

// BotDataDir is the data directory of one bot, <volumeRoot>/<botKey>, with the
// volume root resolved the way Quota resolves it. The key must be a lowercase
// UUID (route.IsBotKey): it has no separator, no "." or ".." and no NUL, so it
// names one direct child of the root. The result is checked to be exactly that
// child all the same: no key can name a path outside the volume root.
func BotDataDir(volumeRoot, botKey string) (string, error) {
	if !route.IsBotKey(botKey) {
		return "", ErrBadKey
	}
	if volumeRoot == "" || !filepath.IsAbs(volumeRoot) {
		return "", ErrBotDataRoot
	}
	root, err := filepath.EvalSymlinks(filepath.Clean(volumeRoot))
	if err != nil {
		return "", ErrBotDataRoot
	}
	dir := filepath.Join(root, botKey)
	if filepath.Dir(dir) != root || filepath.Base(dir) != botKey {
		return "", ErrBadKey
	}
	return dir, nil
}

// RemoveBotData removes the data directory of one bot and everything in it.
// removed is false when there was nothing to remove. A link in the place of the
// directory is refused, never followed; below the directory os.RemoveAll does
// not follow links either, so nothing outside the bot's own tree is touched.
func RemoveBotData(volumeRoot, botKey string) (removed bool, err error) {
	dir, err := BotDataDir(volumeRoot, botKey)
	if err != nil {
		return false, err
	}
	fi, err := os.Lstat(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return false, ErrBotDataNotDir
	}
	if err := os.RemoveAll(dir); err != nil {
		return false, err
	}
	return true, nil
}

// BotDataFailure names the reason of a failed RemoveBotData in the fixed
// vocabulary of the log: the text of a host error (a path, an errno string) is
// never logged.
func BotDataFailure(err error) string {
	switch {
	case errors.Is(err, ErrBadKey):
		return "bad_key"
	case errors.Is(err, ErrBotDataRoot):
		return "volume_root"
	case errors.Is(err, ErrBotDataNotDir):
		return "not_a_directory"
	case errors.Is(err, syscall.EROFS):
		return "read_only"
	case errors.Is(err, fs.ErrPermission):
		return "permission"
	default:
		return "remove"
	}
}
