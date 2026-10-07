// Package disk applies the XFS project quota of a bot directory (contract C5,
// BOT-DISK-H9b: PUT /myrmidon/disk/<botKey>/quota {bytes}).
//
// Two things of the host are involved and both are replaceable for the tests:
// the command runner (xfs_quota) and the two files that xfs_quota itself reads
// for the mapping of a directory to a project Id, /etc/projects and /etc/projid.
// The mapping is stable: the Id of a bot is assigned once and reused, so a
// repeated PUT writes the same Id and a different limit.
//
// The Ids are the host's, not the board's: an Id that a bot already has is kept
// even when the limit changes, and an Id of a foreign entry is never reused.
package disk

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

const (
	// MinBytes and MaxBytes are the bounds of a quota (contract C5:
	// WS_QUOTA_MIN_BYTES and WS_QUOTA_MAX_BYTES): 64 MiB and 1 TiB.
	MinBytes = int64(64) << 20
	MaxBytes = int64(1) << 40

	// softNum and softDen make the soft limit 0.8 of the hard one (C5).
	softNum, softDen = 8, 10

	// FirstProjectID is the first project Id handed to a bot. Below it the Ids
	// stay with the administrator of the host.
	FirstProjectID = 1000

	// LastProjectID bounds the search for a free Id.
	LastProjectID = uint32(1) << 24

	// ProjectsFile and ProjidFile are the two files of the mapping, the ones
	// that xfs_quota reads: "<id>: <path>" and "<name>: <id>".
	ProjectsFile = "/etc/projects"
	ProjidFile   = "/etc/projid"

	// MountsFile is the mount table: the mount options of the volume root are
	// what says whether the partition carries prjquota at all.
	MountsFile = "/proc/mounts"

	// QuotaBin is the xfs_quota of the host.
	QuotaBin = "xfs_quota"
)

// Result is the effect of an apply: the Id of the bot and the two limits, as
// the answer of C5 needs them.
type Result struct {
	ProjectID uint32
	HardBytes int64
	SoftBytes int64
}

// Executor runs one command of the host. The tests replace it with a journal.
type Executor interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

// OSExecutor runs the commands of the host.
type OSExecutor struct{}

// Run runs one command and returns its combined output.
func (OSExecutor) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// Projects is the mapping of a bot key to a project Id, kept in the two files
// of the host that xfs_quota reads.
type Projects struct {
	ProjectsFile string
	ProjidFile   string
}

// ProjectName is the name of a bot in /etc/projid. The key alone would be a
// valid name, but the prefix keeps the entries of the bots recognizable in a
// file that the administrator also edits.
func ProjectName(botKey string) string { return "myrmidon-" + botKey }

// Applier is the disk of one dockergate: the volume root of the bots, the two
// files of the mapping, the mount table and the command runner.
type Applier struct {
	Exec       Executor
	VolumeRoot string
	Files      Projects
	// MountsFile and QuotaBin: empty means the default of the host.
	MountsFile string
	QuotaBin   string

	// mu serializes the assignment of an Id. Two bots ask for one at the same
	// time; the files are replaced as a whole, so the second read must wait for
	// the first write.
	mu sync.Mutex
}

// New builds the applier of the host with this volume root.
func New(volumeRoot string) *Applier {
	return &Applier{
		Exec:       OSExecutor{},
		VolumeRoot: volumeRoot,
		Files:      Projects{ProjectsFile: ProjectsFile, ProjidFile: ProjidFile},
	}
}

// DirOf is the directory of a bot under the volume root: the path that the
// project of the bot covers.
func (a *Applier) DirOf(botKey string) string { return a.VolumeRoot + "/" + botKey }

// Apply sets the hard and soft limit of a bot and returns the Id it got. It is
// idempotent: the same bot keeps its Id, and only the limits change.
//
// The order is the one the filesystem demands: the mapping has to be in the
// files before xfs_quota can carry it into the filesystem ("project -s" looks
// the directory up in /etc/projects), and prjquota has to be on before anything
// of the host is touched.
func (a *Applier) Apply(ctx context.Context, botKey string, bytes int64) (Result, *deny.Error) {
	if bytes < MinBytes || bytes > MaxBytes {
		return Result{}, deny.Field(deny.BadQuota, "bytes", []byte(strconv.FormatInt(bytes, 10)))
	}
	ok, derr := a.QuotaEnabled()
	if derr != nil {
		return Result{}, derr
	}
	if !ok {
		return Result{}, deny.New(deny.QuotaUnavailable)
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	dir := a.DirOf(botKey)
	id, err := a.Files.Assign(botKey, dir)
	if err != nil {
		return Result{}, internal("project_files", err)
	}
	soft := bytes * softNum / softDen
	key := strconv.FormatUint(uint64(id), 10)
	args := []string{
		"-x",
		"-c", "project -s -p " + dir + " " + key,
		"-c", "limit -p bhard=" + strconv.FormatInt(bytes, 10) +
			" bsoft=" + strconv.FormatInt(soft, 10) + " " + key,
	}
	if _, err := a.exec().Run(ctx, a.bin(), args...); err != nil {
		return Result{}, internal("xfs_quota", err)
	}
	return Result{ProjectID: id, HardBytes: bytes, SoftBytes: soft}, nil
}

// QuotaEnabled reports whether the volume root is mounted with project quota.
// The mount table answers it: the option is what the kernel enforces, while the
// state of xfs_quota would have to be parsed out of its output.
func (a *Applier) QuotaEnabled() (bool, *deny.Error) {
	data, err := os.ReadFile(a.mountsFile())
	if err != nil {
		return false, internal("mounts", err)
	}
	opts, ok := MountOptionsFor(string(data), a.VolumeRoot)
	if !ok {
		// A volume root that no mount covers cannot carry a quota of a bot
		// either: for the route that is the same "no" as a partition without
		// prjquota.
		return false, deny.New(deny.QuotaUnavailable).WithDetail("volume_root_unmounted")
	}
	for _, opt := range strings.Split(opts, ",") {
		if opt == "prjquota" || opt == "pquota" {
			return true, nil
		}
	}
	return false, nil
}

// MountOptionsFor returns the options of the mount that covers path: the
// longest mount point that is a prefix of it, component by component.
func MountOptionsFor(mounts, path string) (string, bool) {
	best, opts := "", ""
	for _, line := range strings.Split(mounts, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		mp := unescapeMountPoint(f[1])
		if !covers(mp, path) {
			continue
		}
		if len(mp) > len(best) {
			best, opts = mp, f[3]
		}
	}
	return opts, best != ""
}

// covers reports whether the mount point mp contains path.
func covers(mp, path string) bool {
	if mp == "/" {
		return strings.HasPrefix(path, "/")
	}
	return path == mp || strings.HasPrefix(path, mp+"/")
}

// unescapeMountPoint decodes the escapes of the mount table (\040 for a space,
// \011, \012 and \134). The volume root of a configuration never contains one
// (config.Validate refuses them), but the mount point above it may.
func unescapeMountPoint(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	r := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	return r.Replace(s)
}

func (a *Applier) exec() Executor {
	if a.Exec != nil {
		return a.Exec
	}
	return OSExecutor{}
}

func (a *Applier) bin() string {
	if a.QuotaBin != "" {
		return a.QuotaBin
	}
	return QuotaBin
}

func (a *Applier) mountsFile() string {
	if a.MountsFile != "" {
		return a.MountsFile
	}
	return MountsFile
}

// internal is the denial of a failure of the host itself: it is nobody's
// request, so it is a 500 with a fixed-vocabulary hint and no value.
func internal(detail string, err error) *deny.Error {
	e := deny.New(deny.UpstreamError).WithStatus(http.StatusInternalServerError).WithDetail(detail)
	if err != nil {
		e.Detail = detail + ":" + shortError(err)
	}
	return e
}

// shortError keeps a hint short: the first word of the error of the host, with
// no path and no value of a request.
func shortError(err error) string {
	s := err.Error()
	if i := strings.IndexAny(s, ": "); i > 0 {
		s = s[:i]
	}
	if len(s) > 40 {
		s = s[:40]
	}
	return s
}

// --- the mapping ---------------------------------------------------------------

// Assign returns the project Id of a bot, giving it one if it has none yet, and
// makes sure that both files hold the mapping. The Id of a bot never changes.
//
// Both files are always written, so a crash between the two (each is replaced
// as a whole) is repaired by the next call: an Id found by name keeps the Id, an
// Id found by directory keeps it too, and both lines are then completed.
func (p Projects) Assign(botKey, dir string) (uint32, error) {
	if !strings.HasPrefix(dir, "/") || strings.Contains(dir, "\n") {
		return 0, errors.New("projects: the directory of a bot must be an absolute path")
	}
	projid, err := readLines(p.projidFile())
	if err != nil {
		return 0, err
	}
	projects, err := readLines(p.projectsFile())
	if err != nil {
		return 0, err
	}
	id, err := assignedID(projects, projid, ProjectName(botKey), dir)
	if err != nil {
		return 0, err
	}
	if err := writeFileAtomic(p.projectsFile(), appendLineIfMissing(projects, strconv.FormatUint(uint64(id), 10)+": "+dir)); err != nil {
		return 0, err
	}
	if err := writeFileAtomic(p.projidFile(), appendLineIfMissing(projid, ProjectName(botKey)+": "+strconv.FormatUint(uint64(id), 10))); err != nil {
		return 0, err
	}
	return id, nil
}

// appendLineIfMissing keeps the files of the mapping from growing a second copy
// of a line that is already there: a repeated PUT must not change them.
func appendLineIfMissing(lines []string, line string) []string {
	for _, l := range lines {
		if strings.TrimSpace(l) == line {
			return lines
		}
	}
	return append(lines, line)
}

// assignedID is the Id the bot already has — by its name in /etc/projid, or by
// its directory in /etc/projects when a torn write left only one of the lines —
// or a free one.
func assignedID(projects, projid []string, name, dir string) (uint32, error) {
	if id, ok := projidID(projid, name); ok {
		return id, nil
	}
	for _, line := range projects {
		head, rest, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(rest) != dir {
			continue
		}
		if id, err := strconv.ParseUint(strings.TrimSpace(head), 10, 32); err == nil {
			return uint32(id), nil
		}
	}
	return freeID(projects, projid)
}

// projidID looks a name up in the lines of /etc/projid ("<name>: <id>").
func projidID(lines []string, name string) (uint32, bool) {
	for _, line := range lines {
		rest, ok := strings.CutPrefix(line, name+":")
		if !ok {
			continue
		}
		if id, err := strconv.ParseUint(strings.TrimSpace(rest), 10, 32); err == nil {
			return uint32(id), true
		}
	}
	return 0, false
}

// freeID is the smallest Id at or above FirstProjectID that neither file uses.
func freeID(projects, projid []string) (uint32, error) {
	used := map[uint32]bool{}
	for _, line := range projects {
		head, _, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if id, err := strconv.ParseUint(strings.TrimSpace(head), 10, 32); err == nil {
			used[uint32(id)] = true
		}
	}
	for _, line := range projid {
		head, _, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if id, err := strconv.ParseUint(strings.TrimSpace(head), 10, 32); err == nil {
			used[uint32(id)] = true
		}
	}
	for id := uint32(FirstProjectID); id < LastProjectID; id++ {
		if !used[id] {
			return id, nil
		}
	}
	return 0, errors.New("projects: no free project id")
}

// readLines reads a file of the mapping. A file that is absent is an empty one
// (the first assignment creates it); anything else is a failure.
func readLines(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return nil, nil
	}
	return lines, nil
}

// writeFileAtomic replaces a file of the mapping as a whole: the lines land in a
// temporary file of the same directory and reach the name by a rename, so a
// reader of the file (xfs_quota itself) never sees half of a mapping and a
// failure leaves the file it had.
func writeFileAtomic(path string, lines []string) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer func() {
		if tmp != "" {
			_ = os.Remove(tmp)
		}
	}()
	sorted := append([]string(nil), lines...)
	sort.SliceStable(sorted, func(i, j int) bool { return lineKey(sorted[i]) < lineKey(sorted[j]) })
	data := []byte(strings.Join(sorted, "\n") + "\n")
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("projects: write %s: %w", path, err)
	}
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		return fmt.Errorf("projects: chmod %s: %w", path, err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("projects: sync %s: %w", path, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("projects: close %s: %w", path, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("projects: rename %s: %w", path, err)
	}
	tmp = ""
	return nil
}

// lineKey is the numeric part of a line of a mapping, for a stable order of the
// file: the host's tools print the lines sorted by Id.
func lineKey(line string) string {
	head, _, _ := strings.Cut(line, ":")
	return strings.TrimSpace(head)
}

func (p Projects) projectsFile() string {
	if p.ProjectsFile != "" {
		return p.ProjectsFile
	}
	return ProjectsFile
}

func (p Projects) projidFile() string {
	if p.ProjidFile != "" {
		return p.ProjidFile
	}
	return ProjidFile
}
