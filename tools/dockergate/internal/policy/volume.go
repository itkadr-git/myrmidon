package policy

import (
	"errors"
	"io/fs"
	"os"
	"syscall"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// BotUID is the uid the bot image runs as (and the owner of the profile
// files the board uploads).
const BotUID = 10001

// FileInfo is the part of lstat that the volume-root invariants read.
type FileInfo struct {
	Dir     bool
	Symlink bool
	UID     uint32
	// Perm is the permission bits (mode & 0o777).
	Perm uint32
}

// LstatFunc is lstat; tests inject one that can lie about the owner and can
// return EACCES.
type LstatFunc func(path string) (FileInfo, error)

// OSLstat is the real lstat.
func OSLstat(path string) (FileInfo, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return FileInfo{}, err
	}
	var uid uint32
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		uid = st.Uid
	} else {
		return FileInfo{}, errors.New("no stat_t")
	}
	return FileInfo{
		Dir:     fi.Mode().IsDir(),
		Symlink: fi.Mode()&fs.ModeSymlink != 0,
		UID:     uid,
		Perm:    uint32(fi.Mode().Perm()),
	}, nil
}

func volumeDenied(which string) *deny.Error {
	return deny.New(deny.VolumeRootInvariant).WithDetail(which)
}

// CheckVolumeRoot verifies the invariants of the volume tree of one bot
// (spec 7.5). It runs on every create of every form, before anything reaches
// the daemon: Docker follows a symlink in the source of a bind mount, so a
// root helper that gets a bind whose source was swapped for a link would hand
// the host to uid 10001.
//
//   - volumeRoot: a directory, not a link, owned by root, not writable by
//     group or others.
//   - volumeRoot/K, when it exists: the same, and dockergate can enter it
//     (EACCES on a child is a denial: a directory that cannot be checked is
//     not a checked directory). Traversal by the BOT's uid is deliberately not
//     an invariant here (myrmidon(BOT-ROOT-TRAVERSE)): the incident mode —
//     root-owned 0710, group r-x only for dockergate — passes this check (the
//     gate can enter via the group bit, uid 10001 cannot), and that is exactly
//     the window the product fix needs: the prepare-helper create goes through
//     the gate, then its script chmods K to 0711 so the bot can enter its one
//     /bot mount, without the gate ever widening what any create may touch.
//     The child invariants stay strict, and dockergate keeps its own traversal
//     after the fix (0711 gives "other" the x bit too).
//   - hermes, workspace, scratch, when they exist: a directory (not a link,
//     not another type), owned by root or by the bot uid, not writable by group
//     or others.
//
// Absence is allowed: Docker creates the missing directories as root, 0755.
func CheckVolumeRoot(lstat LstatFunc, volumeRoot, botKey string) *deny.Error {
	rootFI, err := lstat(volumeRoot)
	if err != nil || !rootFI.Dir || rootFI.Symlink || rootFI.UID != 0 || rootFI.Perm&0o022 != 0 {
		return volumeDenied("volume.root")
	}
	kPath := volumeRoot + "/" + botKey
	kFI, err := lstat(kPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return volumeDenied("volume.K")
	}
	if !kFI.Dir || kFI.Symlink || kFI.UID != 0 || kFI.Perm&0o022 != 0 {
		return volumeDenied("volume.K")
	}
	for _, child := range []string{"hermes", "workspace", "scratch"} {
		fi, err := lstat(kPath + "/" + child)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return volumeDenied("volume." + child)
		}
		if !fi.Dir || fi.Symlink || (fi.UID != 0 && fi.UID != BotUID) || fi.Perm&0o022 != 0 {
			return volumeDenied("volume." + child)
		}
	}
	return nil
}

// CheckScopeDir verifies the host tree of a member of a shared scope instance
// (BOT-DISK-F), the way CheckVolumeRoot does for an isolated bot. It runs on
// every create whose body names an instance, before anything reaches the
// daemon, for the same reason: Docker follows a link in the source of a bind.
//
//   - scopeRoot, when it exists: a directory, not a link, owned by root, not
//     writable by group or others;
//   - scopeRoot/I (the instance directory) and scopeRoot/I/K (the member's
//     subdirectory), when they exist: a directory, not a link, owned by root or
//     by the bot uid, not writable by group or others, and enterable;
//   - hermes, workspace, scratch under the member's subdirectory: as in
//     CheckVolumeRoot.
//
// Absence is allowed: Docker creates what is missing, as root.
func CheckScopeDir(lstat LstatFunc, scopeRoot, instance, botKey string) *deny.Error {
	rootFI, err := lstat(scopeRoot)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return volumeDenied("scope.root")
	}
	if !rootFI.Dir || rootFI.Symlink || rootFI.UID != 0 || rootFI.Perm&0o022 != 0 {
		return volumeDenied("scope.root")
	}
	for _, level := range []struct{ path, which string }{
		{scopeRoot + "/" + instance, "scope.instance"},
		{scopeRoot + "/" + instance + "/" + botKey, "scope.K"},
	} {
		fi, err := lstat(level.path)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return volumeDenied(level.which)
		}
		if !fi.Dir || fi.Symlink || (fi.UID != 0 && fi.UID != BotUID) || fi.Perm&0o022 != 0 {
			return volumeDenied(level.which)
		}
	}
	kPath := scopeRoot + "/" + instance + "/" + botKey
	for _, child := range []string{"hermes", "workspace", "scratch"} {
		fi, err := lstat(kPath + "/" + child)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return volumeDenied("scope." + child)
		}
		if !fi.Dir || fi.Symlink || (fi.UID != 0 && fi.UID != BotUID) || fi.Perm&0o022 != 0 {
			return volumeDenied("scope." + child)
		}
	}
	return nil
}
