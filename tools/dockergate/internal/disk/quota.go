// Package disk holds the disk routes of dockergate (contract C5). PUT
// /myrmidon/disk/<botKey>/quota sets the XFS project quota of one bot volume:
// it keeps the stable botKey -> project id map in /etc/projid and /etc/projects
// and runs xfs_quota. Everything that touches the host goes through Executor and
// the two file paths, so that the tests run on a temporary directory and a fake.
package disk

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
)

// Bounds of a quota (WS_QUOTA_MIN_BYTES / WS_QUOTA_MAX_BYTES of the contract):
// [64 MiB; 1 TiB].
const (
	MinQuotaBytes int64 = 64 << 20
	MaxQuotaBytes int64 = 1 << 40
)

// FirstProjectID is the first project id that dockergate hands out.
const FirstProjectID = 1000

// Defaults of the host.
const (
	DefaultProjectsFile = "/etc/projects"
	DefaultProjidFile   = "/etc/projid"
	DefaultXFSQuota     = "xfs_quota"
)

// Errors of Put. Anything else is a failure of the host (a file that cannot be
// written, xfs_quota that fails) and is not a decision about the request.
var (
	// ErrBadKey: the botKey is not a lowercase UUID.
	ErrBadKey = errors.New("disk: bad bot key")
	// ErrBadQuota: bytes is outside [MinQuotaBytes; MaxQuotaBytes].
	ErrBadQuota = errors.New("disk: quota out of range")
	// ErrQuotaUnavailable: project quota is not enabled on the bot partition.
	ErrQuotaUnavailable = errors.New("disk: project quota is not enabled")
)

// Executor runs a program of the host and returns its standard output. It is
// the one interface through which the disk routes touch xfs_quota (contract C5);
// the tests give a fake that keeps a journal.
type Executor interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

// OSExecutor runs the program for real.
type OSExecutor struct{}

// Run implements Executor.
func (OSExecutor) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

// Result is the answer of a successful Put (wsDiskQuotaPutResponseSchema).
type Result struct {
	ProjectID int
	HardBytes int64
}

// Quota sets project quotas on the bot volumes.
type Quota struct {
	// VolumeRoot is the directory with one subdirectory per bot key.
	VolumeRoot string
	// ProjectsFile and ProjidFile are /etc/projects and /etc/projid.
	ProjectsFile string
	ProjidFile   string
	// Binary is xfs_quota.
	Binary string
	Exec   Executor

	mu sync.Mutex
}

// NewQuota is a Quota with the defaults of the host. A nil exec is OSExecutor.
func NewQuota(volumeRoot string, ex Executor) *Quota {
	if ex == nil {
		ex = OSExecutor{}
	}
	return &Quota{
		VolumeRoot:   volumeRoot,
		ProjectsFile: DefaultProjectsFile,
		ProjidFile:   DefaultProjidFile,
		Binary:       DefaultXFSQuota,
		Exec:         ex,
	}
}

// ValidBytes reports whether bytes is inside the bounds of the contract.
func ValidBytes(n int64) bool { return n >= MinQuotaBytes && n <= MaxQuotaBytes }

// softBytes is the soft limit: 0.8 of the hard one, rounded down (hard is at
// most 1 TiB, so the product does not overflow).
func softBytes(hard int64) int64 { return hard * 8 / 10 }

// Put sets the hard limit of the bot's volume to hard bytes and the soft one to 0.8 of
// it. It is idempotent: the same botKey keeps its project id, the files are not
// rewritten when they already say the same, and xfs_quota is run again with the
// same arguments.
func (q *Quota) Put(ctx context.Context, botKey string, hard int64) (Result, error) {
	if !route.IsBotKey(botKey) {
		return Result{}, ErrBadKey
	}
	if !ValidBytes(hard) {
		return Result{}, ErrBadQuota
	}
	q.mu.Lock()
	defer q.mu.Unlock()

	if err := q.checkEnabled(ctx); err != nil {
		return Result{}, err
	}

	projid, err := readLines(q.ProjidFile)
	if err != nil {
		return Result{}, fmt.Errorf("disk: read %s: %w", q.ProjidFile, err)
	}
	projects, err := readLines(q.ProjectsFile)
	if err != nil {
		return Result{}, fmt.Errorf("disk: read %s: %w", q.ProjectsFile, err)
	}
	id := allocate(botKey, projid, projects)
	dir := q.VolumeRoot + "/" + botKey

	newProjid, changedA := setLine(projid, func(l string) bool { return lineKey(l) == botKey }, botKey+":"+strconv.Itoa(id))
	idText := strconv.Itoa(id)
	newProjects, changedB := setLine(projects, func(l string) bool { return lineKey(l) == idText }, idText+":"+dir)
	// projid first: a project that is in /etc/projects but has no name is the
	// worse half-state.
	if changedA {
		if err := writeAtomic(q.ProjidFile, joinLines(newProjid)); err != nil {
			return Result{}, fmt.Errorf("disk: write %s: %w", q.ProjidFile, err)
		}
	}
	if changedB {
		if err := writeAtomic(q.ProjectsFile, joinLines(newProjects)); err != nil {
			return Result{}, fmt.Errorf("disk: write %s: %w", q.ProjectsFile, err)
		}
	}

	_, err = q.Exec.Run(ctx, q.Binary, "-x",
		"-c", "project -s -p "+dir+" "+idText,
		"-c", "limit -p bhard="+strconv.FormatInt(hard, 10)+" bsoft="+strconv.FormatInt(softBytes(hard), 10)+" "+idText,
		q.VolumeRoot)
	if err != nil {
		return Result{}, fmt.Errorf("disk: xfs_quota: %w", err)
	}
	return Result{ProjectID: id, HardBytes: hard}, nil
}

// checkEnabled asks xfs_quota for the project quota state of the volume root.
// Accounting and enforcement both ON is the only "enabled"; a failing xfs_quota
// (not an XFS volume, no such mount) is "unavailable" too, because there is no
// quota to set.
func (q *Quota) checkEnabled(ctx context.Context) error {
	out, err := q.Exec.Run(ctx, q.Binary, "-x", "-c", "state -p", q.VolumeRoot)
	if err != nil {
		return ErrQuotaUnavailable
	}
	if !bytes.Contains(out, []byte("Accounting: ON")) || !bytes.Contains(out, []byte("Enforcement: ON")) {
		return ErrQuotaUnavailable
	}
	return nil
}

// --- /etc/projid and /etc/projects ---------------------------------------------

// readLines reads a file as lines; a file that does not exist has none.
func readLines(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	s := strings.TrimSuffix(string(data), "\n")
	if s == "" {
		return nil, nil
	}
	return strings.Split(s, "\n"), nil
}

func joinLines(lines []string) []byte {
	if len(lines) == 0 {
		return nil
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

// lineKey is the text before the first ":" of a line ("" for a comment).
func lineKey(l string) string {
	l = strings.TrimSpace(l)
	if l == "" || strings.HasPrefix(l, "#") {
		return ""
	}
	k, _, _ := strings.Cut(l, ":")
	return strings.TrimSpace(k)
}

// lineValue is the text after the first ":" of a line.
func lineValue(l string) string {
	_, v, _ := strings.Cut(strings.TrimSpace(l), ":")
	return strings.TrimSpace(v)
}

// setLine puts line in place of the first line that match accepts (dropping any
// further match) or at the end. changed is false when the lines already say it.
func setLine(lines []string, match func(string) bool, line string) (out []string, changed bool) {
	out = make([]string, 0, len(lines)+1)
	placed := false
	for _, l := range lines {
		if lineKey(l) != "" && match(l) {
			if placed {
				changed = true
				continue
			}
			placed = true
			if l != line {
				changed = true
			}
			out = append(out, line)
			continue
		}
		out = append(out, l)
	}
	if !placed {
		out = append(out, line)
		changed = true
	}
	return out, changed
}

// allocate is the project id of a bot: the one that /etc/projid already has for
// its key, else the next free one (the largest id in either file plus one, not
// below FirstProjectID). Ids are never reused for another bot, so the map is
// stable.
func allocate(botKey string, projid, projects []string) int {
	next := FirstProjectID
	for _, l := range projid {
		k := lineKey(l)
		if k == "" {
			continue
		}
		id, err := strconv.Atoi(lineValue(l))
		if err != nil || id < 0 {
			continue
		}
		if k == botKey {
			return id
		}
		if id >= next {
			next = id + 1
		}
	}
	for _, l := range projects {
		if lineKey(l) == "" {
			continue
		}
		if id, err := strconv.Atoi(lineKey(l)); err == nil && id >= next {
			next = id + 1
		}
	}
	return next
}

// writeAtomic replaces path with data: a temporary file in the same directory,
// synced, then renamed over the target. A reader sees the old file or the new
// one, never a half-written one, and a failure leaves the old file as it was.
func writeAtomic(path string, data []byte) error {
	perm := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		perm = fi.Mode().Perm()
	}
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		return err
	}
	if err := f.Chmod(perm); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
