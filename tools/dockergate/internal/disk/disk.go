// Package disk answers GET /myrmidon/disk (route A14, contract C5): the physical
// state of the bot partition, from statfs of the volume root, and the project
// quotas, from `xfs_quota -x -c 'report -p -b -N'`.
//
// Nothing here talks to the host directly: statfs, the quota command and the
// project table are passed in, so a test feeds recorded output.
package disk

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ProjidPath is the project name table that dockergate maintains
// (name:id, one per line). xfs_quota prints the name of a project from it.
const ProjidPath = "/etc/projid"

// XfsQuotaBin and ReportArgs are the one quota command of this route: fixed, no
// argument comes from a request.
const XfsQuotaBin = "/usr/sbin/xfs_quota"

// ReportArgs is the argument list of the report; the mount point is appended.
var ReportArgs = []string{"-x", "-c", "report -p -b -N"}

// Project is one bot project of the report (contract wsDiskProjectSchema).
type Project struct {
	BotKey    string `json:"botKey"`
	ProjectID uint64 `json:"projectId"`
	UsedBytes uint64 `json:"usedBytes"`
	SoftBytes uint64 `json:"softBytes"`
	HardBytes uint64 `json:"hardBytes"`
}

// Partition is the statfs part of the answer (wsDiskPartitionSchema).
type Partition struct {
	Mount       string  `json:"mount"`
	TotalBytes  uint64  `json:"totalBytes"`
	UsedBytes   uint64  `json:"usedBytes"`
	FreeBytes   uint64  `json:"freeBytes"`
	UsedPercent float64 `json:"usedPercent"`
}

// Other is the used space that no bot project owns.
type Other struct {
	UsedBytes uint64 `json:"usedBytes"`
}

// Response is the body of GET /myrmidon/disk (wsDiskApiResponseSchema).
type Response struct {
	Partition    Partition `json:"partition"`
	Projects     []Project `json:"projects"`
	Other        Other     `json:"other"`
	QuotaEnabled bool      `json:"quotaEnabled"`
	At           string    `json:"at"`
}

// Fs is the part of statfs(2) that the answer needs.
type Fs struct {
	BlockSize uint64
	Blocks    uint64
	Free      uint64 // blocks free for a non-root user (f_bavail)
	FreeRoot  uint64 // blocks free in all (f_bfree)
}

// StatfsFunc reads the file system of a path; tests replace it.
type StatfsFunc func(path string) (Fs, error)

// OSStatfs is StatfsFunc over statfs(2).
func OSStatfs(path string) (Fs, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return Fs{}, err
	}
	return Fs{BlockSize: uint64(st.Bsize), Blocks: uint64(st.Blocks), Free: uint64(st.Bavail), FreeRoot: uint64(st.Bfree)}, nil
}

// Runner runs the quota command and returns its standard output. A non-zero
// exit is an error (the output is then not looked at).
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// OSRunner is Runner over os/exec with an empty environment.
func OSRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	return cmd.Output()
}

// ReadFileFunc reads the project table; tests replace it.
type ReadFileFunc func(path string) ([]byte, error)

// Deps are the host-facing parts of Collect.
type Deps struct {
	Statfs   StatfsFunc
	Run      Runner
	ReadFile ReadFileFunc
	Now      func() time.Time
	// QuotaBin is the quota command; empty means XfsQuotaBin.
	QuotaBin string
}

func (d Deps) withDefaults() Deps {
	if d.Statfs == nil {
		d.Statfs = OSStatfs
	}
	if d.Run == nil {
		d.Run = OSRunner
	}
	if d.ReadFile == nil {
		d.ReadFile = os.ReadFile
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.QuotaBin == "" {
		d.QuotaBin = XfsQuotaBin
	}
	return d
}

// ErrStatfs is returned by Collect when the volume root cannot be read.
var ErrStatfs = errors.New("disk: statfs failed")

// ErrReport is returned by Collect when the quota report is there but cannot be
// read: a wrong number is worse than none.
var ErrReport = errors.New("disk: unreadable quota report")

// Collect builds the answer for volumeRoot. A quota command that fails (project
// quota is not mounted, the tool is missing) is not an error: the answer is
// quotaEnabled=false with no projects. The one exception is a context that has
// ended, which is returned as is.
func Collect(ctx context.Context, volumeRoot string, deps Deps) (*Response, error) {
	deps = deps.withDefaults()
	fs, err := deps.Statfs(volumeRoot)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStatfs, err)
	}
	resp := &Response{
		Partition: partition(volumeRoot, fs),
		Projects:  []Project{},
		At:        deps.Now().UTC().Format("2006-01-02T15:04:05Z"),
	}

	args := append(append([]string{}, ReportArgs...), volumeRoot)
	out, err := deps.Run(ctx, deps.QuotaBin, args...)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return resp, nil
	}
	var names map[string]uint64
	if raw, rerr := deps.ReadFile(ProjidPath); rerr == nil {
		names = ParseProjid(raw)
	}
	projects, other, perr := ParseReport(out, names)
	if perr != nil {
		return nil, fmt.Errorf("%w: %v", ErrReport, perr)
	}
	resp.QuotaEnabled = true
	resp.Projects = projects
	resp.Other = Other{UsedBytes: other}
	return resp, nil
}

func partition(mount string, fs Fs) Partition {
	total := fs.Blocks * fs.BlockSize
	freeAll := fs.FreeRoot * fs.BlockSize
	used := uint64(0)
	if total > freeAll {
		used = total - freeAll
	}
	free := fs.Free * fs.BlockSize
	if free > total {
		free = total
	}
	pct := 0.0
	if total > 0 {
		pct = math.Round(float64(used)/float64(total)*1000) / 10
		if pct > 100 {
			pct = 100
		}
	}
	return Partition{Mount: mount, TotalBytes: total, UsedBytes: used, FreeBytes: free, UsedPercent: pct}
}

// ParseProjid reads /etc/projid ("name:id" per line, "#" comments) into a
// name -> id table. A line that is not of that form is skipped.
func ParseProjid(raw []byte) map[string]uint64 {
	m := map[string]uint64{}
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, idStr, ok := strings.Cut(line, ":")
		if !ok || name == "" {
			continue
		}
		id, err := strconv.ParseUint(strings.TrimSpace(idStr), 10, 32)
		if err != nil {
			continue
		}
		m[name] = id
	}
	return m
}

// ParseReport reads the output of `xfs_quota -x -c 'report -p -b -N'`.
//
// Every data line is: project, used, soft, hard, then warnings and the grace
// column, which are ignored. The project is a name from the project table, or
// "#<id>" when the id has no name. Sizes are 1 KiB blocks (the default of
// -b), or a number with a binary suffix (K M G T P E, as -h prints) with an
// optional fraction.
//
// A line whose project is a known name becomes a Project (its id is looked up in
// names). Lines of "#0" (files outside any project), of an unnamed project and
// of a name that is not in names are not bot projects: their used space is
// added up as `other`. Header and separator lines of a report printed without -N
// are skipped. Any other line that cannot be read is an error.
func ParseReport(out []byte, names map[string]uint64) (projects []Project, other uint64, err error) {
	projects = []Project{}
	seen := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || isReportNoise(line) {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 4 {
			return nil, 0, fmt.Errorf("line %d: %d fields", lineNo, len(f))
		}
		used, uerr := parseSize(f[1])
		soft, serr := parseSize(f[2])
		hard, herr := parseSize(f[3])
		if uerr != nil || serr != nil || herr != nil {
			return nil, 0, fmt.Errorf("line %d: bad size", lineNo)
		}
		name := f[0]
		id, known := names[name]
		if strings.HasPrefix(name, "#") || !known {
			other, err = addSat(other, used)
			if err != nil {
				return nil, 0, err
			}
			continue
		}
		if seen[name] {
			return nil, 0, fmt.Errorf("line %d: project listed twice", lineNo)
		}
		seen[name] = true
		projects = append(projects, Project{BotKey: name, ProjectID: id, UsedBytes: used, SoftBytes: soft, HardBytes: hard})
	}
	if serr := sc.Err(); serr != nil {
		return nil, 0, serr
	}
	return projects, other, nil
}

func addSat(a, b uint64) (uint64, error) {
	if a > math.MaxUint64-b {
		return 0, errors.New("sum overflows")
	}
	return a + b, nil
}

// isReportNoise is a line that a report prints around its rows when -N is not
// in effect.
func isReportNoise(line string) bool {
	switch {
	case strings.HasPrefix(line, "Project quota on "),
		strings.HasPrefix(line, "Blocks"),
		strings.HasPrefix(line, "Project ID"),
		strings.HasPrefix(line, "---"):
		return true
	}
	return false
}

// parseSize reads a size of the report in bytes: plain digits are 1 KiB blocks;
// digits (with an optional fraction) and one binary suffix are that many of the
// unit.
func parseSize(s string) (uint64, error) {
	if s == "" {
		return 0, errors.New("empty")
	}
	unit := uint64(1024)
	num := s
	if last := s[len(s)-1]; last < '0' || last > '9' {
		switch last {
		case 'B', 'b':
			unit = 1
		case 'K', 'k':
			unit = 1 << 10
		case 'M', 'm':
			unit = 1 << 20
		case 'G', 'g':
			unit = 1 << 30
		case 'T', 't':
			unit = 1 << 40
		case 'P', 'p':
			unit = 1 << 50
		case 'E', 'e':
			unit = 1 << 60
		default:
			return 0, fmt.Errorf("unit %q", last)
		}
		num = s[:len(s)-1]
	}
	whole, frac, hasFrac := strings.Cut(num, ".")
	if whole == "" || (hasFrac && frac == "") {
		return 0, errors.New("number")
	}
	w, err := strconv.ParseUint(whole, 10, 64)
	if err != nil {
		return 0, err
	}
	if w > math.MaxUint64/unit {
		return 0, errors.New("overflow")
	}
	total := w * unit
	if hasFrac {
		fv, err := strconv.ParseFloat("0."+frac, 64)
		if err != nil {
			return 0, err
		}
		add := uint64(math.Round(fv * float64(unit)))
		if total > math.MaxUint64-add {
			return 0, errors.New("overflow")
		}
		total += add
	}
	return total, nil
}
