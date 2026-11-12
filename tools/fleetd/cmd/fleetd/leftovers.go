package main

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// A restore moves the datadir it replaces to ".replaced-<bot>-<unix nanos>"
// and a quarantine moves the datadir to ".quarantined-<bot>-<unix seconds>"
// (handleRestore and handleQuarantine). They are kept for a while as a way
// back and are removed here once they are old enough.

// replacedPrefix and quarantinedPrefix start the names of those directories.
const replacedPrefix = ".replaced-"
const quarantinedPrefix = ".quarantined-"

// leftoverRetentionDays is how long a replaced or quarantined datadir is kept.
const leftoverRetentionDays = 7

// leftoverMaxAge is leftoverRetentionDays as a duration.
const leftoverMaxAge = leftoverRetentionDays * 24 * time.Hour

// leftoverSweepEvery is the interval of the sweep; the first run is at start.
const leftoverSweepEvery = 24 * time.Hour

// leftoverTime returns the moment a directory was set aside, read from its
// name. A name that is not one of ours, or has no usable time, gives false: the
// sweep never removes what it cannot date. The directory time is not used,
// because a rename keeps it and a datadir may have been idle for months.
func leftoverTime(name string) (time.Time, bool) {
	prefix := ""
	switch {
	case strings.HasPrefix(name, replacedPrefix):
		prefix = replacedPrefix
	case strings.HasPrefix(name, quarantinedPrefix):
		prefix = quarantinedPrefix
	default:
		return time.Time{}, false
	}
	i := strings.LastIndexByte(name, '-')
	if i <= len(prefix) {
		return time.Time{}, false
	}
	stamp, err := strconv.ParseInt(name[i+1:], 10, 64)
	if err != nil || stamp <= 0 {
		return time.Time{}, false
	}
	if prefix == replacedPrefix {
		return time.Unix(0, stamp), true
	}
	return time.Unix(stamp, 0), true
}

// staleLeftovers lists the directories directly under root that were set aside
// more than maxAge before now. Files and symlinks are never listed.
func staleLeftovers(root string, now time.Time, maxAge time.Duration) ([]string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var stale []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		set, ok := leftoverTime(e.Name())
		if !ok || now.Sub(set) <= maxAge {
			continue
		}
		stale = append(stale, filepath.Join(root, e.Name()))
	}
	return stale, nil
}

// cleanupLeftovers removes the stale directories under root and returns how
// many it removed. A missing root is not an error: nothing was ever restored.
func cleanupLeftovers(root string, now time.Time, maxAge time.Duration) (int, error) {
	stale, err := staleLeftovers(root, now, maxAge)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	removed := 0
	var firstErr error
	for _, dir := range stale {
		if err := os.RemoveAll(dir); err != nil {
			log.Printf("cleanup: cannot remove %s: %v", filepath.Base(dir), err)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		log.Printf("cleanup: removed %s", filepath.Base(dir))
		removed++
	}
	return removed, firstErr
}

// runLeftoverCleanup sweeps the volume root now and then every interval, until
// ctx ends.
func (s *server) runLeftoverCleanup(ctx context.Context, every time.Duration) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if _, err := cleanupLeftovers(s.volumeRoot(), time.Now(), leftoverMaxAge); err != nil {
			log.Printf("cleanup: %v", err)
		}
		timer.Reset(every)
	}
}
