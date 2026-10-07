package disk

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// The tests of the package run the applier over a temporary directory: the two
// files of the mapping and the mount table are the test's, and the command
// runner is a journal that records what would have been run instead of running
// it (nothing of the host is touched by a test).

// journal is the Executor of a test.
type journal struct {
	calls [][]string
	err   error
}

func (j *journal) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	j.calls = append(j.calls, append([]string{name}, args...))
	if j.err != nil {
		return []byte("xfs_quota: cannot set limits"), j.err
	}
	return nil, nil
}

type host struct {
	a      *Applier
	j      *journal
	root   string
	proj   string
	projID string
	mounts string
}

func newHost(t *testing.T, prjquota bool) *host {
	t.Helper()
	dir := t.TempDir()
	h := &host{
		j:      &journal{},
		root:   "/srv/myrmidon-bots",
		proj:   filepath.Join(dir, "projects"),
		projID: filepath.Join(dir, "projid"),
		mounts: filepath.Join(dir, "mounts"),
	}
	h.a = &Applier{
		Exec:       h.j,
		VolumeRoot: h.root,
		Files:      Projects{ProjectsFile: h.proj, ProjidFile: h.projID},
		MountsFile: h.mounts,
	}
	h.setPrjQuota(prjquota)
	return h
}

// setPrjQuota is the mount table of a host: the bot partition with or without
// the project quota that the route needs.
func (h *host) setPrjQuota(on bool) {
	opts := "rw"
	if on {
		opts = "rw,prjquota"
	}
	table := "sysfs /sys sysfs rw,nosuid,nodev 0 0\n/dev/sdb1 " + h.root + " xfs " + opts + " 0 0\n"
	if err := os.WriteFile(h.mounts, []byte(table), 0o644); err != nil {
		panic(err)
	}
}

func (h *host) read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return ""
	}
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func (h *host) write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func (h *host) calls() []string {
	var out []string
	for _, c := range h.j.calls {
		out = append(out, strings.Join(c, " "))
	}
	return out
}

// wantCalls compares the commands of the journal with the expected ones, one
// string per command.
func (h *host) wantCalls(t *testing.T, want ...string) {
	t.Helper()
	if got := h.calls(); !reflect.DeepEqual(got, want) {
		t.Errorf("commands:\n got %q\nwant %q", got, want)
	}
}

func wantDeny(t *testing.T, derr *deny.Error, code string, status int) {
	t.Helper()
	if derr == nil {
		t.Fatalf("no denial, want %s", code)
	}
	if derr.Code != code || derr.Status != status {
		t.Errorf("denial is %s (%d), want %s (%d)", derr.Code, derr.Status, code, status)
	}
}

func TestApplyRunsTheTwoCommandsOfTheContract(t *testing.T) {
	h := newHost(t, true)
	res, derr := h.a.Apply(context.Background(), "bot-001", 6442450944)
	if derr != nil {
		t.Fatalf("apply: %v", derr)
	}
	if res.ProjectID != FirstProjectID {
		t.Errorf("project id is %d, want the first free one (%d)", res.ProjectID, FirstProjectID)
	}
	if res.HardBytes != 6442450944 || res.SoftBytes != 5153960755 {
		t.Errorf("limits are hard=%d soft=%d, want 6442450944 and 0.8 of it", res.HardBytes, res.SoftBytes)
	}
	h.wantCalls(t,
		"xfs_quota -x -c project -s -p /srv/myrmidon-bots/bot-001 1000 -c limit -p bhard=6442450944 bsoft=5153960755 1000",
	)
	if got, want := h.read(t, h.proj), "1000: /srv/myrmidon-bots/bot-001\n"; got != want {
		t.Errorf("/etc/projects is %q, want %q", got, want)
	}
	if got, want := h.read(t, h.projID), "myrmidon-bot-001: 1000\n"; got != want {
		t.Errorf("/etc/projid is %q, want %q", got, want)
	}
}

func TestApplyKeepsTheProjectIDAndOnlyChangesTheLimit(t *testing.T) {
	h := newHost(t, true)
	first, derr := h.a.Apply(context.Background(), "bot-001", 64<<20)
	if derr != nil {
		t.Fatalf("first apply: %v", derr)
	}
	projects, projid := h.read(t, h.proj), h.read(t, h.projID)
	second, derr := h.a.Apply(context.Background(), "bot-001", 1<<40)
	if derr != nil {
		t.Fatalf("second apply: %v", derr)
	}
	if second.ProjectID != first.ProjectID {
		t.Errorf("the project id changed: %d then %d", first.ProjectID, second.ProjectID)
	}
	if got := h.read(t, h.proj); got != projects {
		t.Errorf("/etc/projects changed on a repeated PUT: %q then %q", projects, got)
	}
	if got := h.read(t, h.projID); got != projid {
		t.Errorf("/etc/projid changed on a repeated PUT: %q then %q", projid, got)
	}
	h.wantCalls(t,
		"xfs_quota -x -c project -s -p /srv/myrmidon-bots/bot-001 1000 -c limit -p bhard=67108864 bsoft=53687091 1000",
		"xfs_quota -x -c project -s -p /srv/myrmidon-bots/bot-001 1000 -c limit -p bhard=1099511627776 bsoft=879609302220 1000",
	)
}

func TestApplyDoesNotReuseTheIDOfAnotherEntry(t *testing.T) {
	h := newHost(t, true)
	h.write(t, h.proj, "1000: /srv/myrmidon-bots/other\n1005: /srv/backup\n")
	h.write(t, h.projID, "backup: 1005\n")
	res, derr := h.a.Apply(context.Background(), "bot-001", 64<<20)
	if derr != nil {
		t.Fatalf("apply: %v", derr)
	}
	if res.ProjectID != 1001 {
		t.Errorf("project id is %d, want 1001 (1000 is taken by another entry)", res.ProjectID)
	}
	// The lines of the administrator stay where they were.
	for _, line := range []string{"1000: /srv/myrmidon-bots/other", "1005: /srv/backup"} {
		if !strings.Contains(h.read(t, h.proj), line) {
			t.Errorf("/etc/projects lost %q", line)
		}
	}
	if !strings.Contains(h.read(t, h.projID), "backup: 1005") {
		t.Error("/etc/projid lost the line of the administrator")
	}
}

func TestApplyCompletesAPairOfFilesTornBetweenTheTwo(t *testing.T) {
	// A crash between the two writes leaves the directory in /etc/projects and
	// no name in /etc/projid: the bot must keep that id, not get a new one.
	h := newHost(t, true)
	h.write(t, h.proj, "1041: /srv/myrmidon-bots/bot-001\n")
	res, derr := h.a.Apply(context.Background(), "bot-001", 64<<20)
	if derr != nil {
		t.Fatalf("apply: %v", derr)
	}
	if res.ProjectID != 1041 {
		t.Errorf("project id is %d, want the one of the leftover line (1041)", res.ProjectID)
	}
	if got, want := h.read(t, h.projID), "myrmidon-bot-001: 1041\n"; got != want {
		t.Errorf("/etc/projid is %q, want %q", got, want)
	}
	if n := strings.Count(h.read(t, h.proj), "\n"); n != 1 {
		t.Errorf("/etc/projects has %d lines, want 1", n)
	}
}

func TestApplyRefusesAQuotaOutsideTheContract(t *testing.T) {
	h := newHost(t, true)
	for _, bytes := range []int64{0, 1, (64 << 20) - 1, (1 << 40) + 1} {
		_, derr := h.a.Apply(context.Background(), "bot-001", bytes)
		wantDeny(t, derr, deny.BadQuota, http.StatusBadRequest)
		if derr.Field != "bytes" || derr.Len == 0 || derr.Hash == "" {
			t.Errorf("bad_quota for %d does not name the field: %+v", bytes, derr)
		}
	}
	if len(h.j.calls) != 0 {
		t.Errorf("the host was touched for a refused quota: %q", h.calls())
	}
	if got := h.read(t, h.proj); got != "" {
		t.Errorf("/etc/projects was written for a refused quota: %q", got)
	}
}

func TestApplyAcceptsTheBounds(t *testing.T) {
	h := newHost(t, true)
	for i, bytes := range []int64{MinBytes, MaxBytes} {
		res, derr := h.a.Apply(context.Background(), "bot-001", bytes)
		if derr != nil {
			t.Fatalf("apply %d: %v", bytes, derr)
		}
		if res.HardBytes != bytes || res.ProjectID != FirstProjectID {
			t.Errorf("bounds %d: got %+v", bytes, res)
		}
		if i == 0 && !strings.Contains(h.calls()[0], "bhard=67108864 ") {
			t.Errorf("the command does not carry the minimum: %q", h.calls())
		}
	}
}

func TestApplyWithoutPrjquotaIsUnavailable(t *testing.T) {
	h := newHost(t, false)
	_, derr := h.a.Apply(context.Background(), "bot-001", 64<<20)
	wantDeny(t, derr, deny.QuotaUnavailable, http.StatusServiceUnavailable)
	if len(h.j.calls) != 0 {
		t.Errorf("xfs_quota was run without prjquota: %q", h.calls())
	}
	if got := h.read(t, h.proj) + h.read(t, h.projID); got != "" {
		t.Errorf("the mapping was written without prjquota: %q", got)
	}
}

func TestApplyWithoutAMountOfTheVolumeRootIsUnavailable(t *testing.T) {
	h := newHost(t, true)
	h.write(t, h.mounts, "sysfs /sys sysfs rw 0 0\n")
	_, derr := h.a.Apply(context.Background(), "bot-001", 64<<20)
	wantDeny(t, derr, deny.QuotaUnavailable, http.StatusServiceUnavailable)
	if derr.Detail != "volume_root_unmounted" {
		t.Errorf("detail is %q, want volume_root_unmounted", derr.Detail)
	}
}

func TestApplyReportsAFailureOfTheHostAs500(t *testing.T) {
	h := newHost(t, true)
	h.j.err = errors.New("exit status 1")
	_, derr := h.a.Apply(context.Background(), "bot-001", 64<<20)
	wantDeny(t, derr, deny.UpstreamError, http.StatusInternalServerError)
	if !strings.HasPrefix(derr.Detail, "xfs_quota") {
		t.Errorf("detail is %q, want a hint about the command", derr.Detail)
	}
}

func TestApplyReportsAnUnwritableMappingAs500(t *testing.T) {
	h := newHost(t, true)
	// The mapping is a directory: it cannot be read as a file of lines.
	if err := os.Mkdir(h.proj, 0o755); err != nil {
		t.Fatal(err)
	}
	_, derr := h.a.Apply(context.Background(), "bot-001", 64<<20)
	wantDeny(t, derr, deny.UpstreamError, http.StatusInternalServerError)
	if !strings.HasPrefix(derr.Detail, "project_files") {
		t.Errorf("detail is %q, want a hint about the mapping", derr.Detail)
	}
	if len(h.j.calls) != 0 {
		t.Errorf("xfs_quota was run without a mapping: %q", h.calls())
	}
}

func TestApplyRefusesADirectoryOutsideTheVolumeRoot(t *testing.T) {
	// The key reaches the applier from the route, that has already checked it
	// as a uuid; a path that is not absolute must not become a mapping.
	if _, err := (Projects{ProjectsFile: "/dev/null", ProjidFile: "/dev/null"}).Assign("bot", "../etc"); err == nil {
		t.Error("a relative directory was accepted")
	}
	if _, err := (Projects{ProjectsFile: "/dev/null", ProjidFile: "/dev/null"}).Assign("bot", "/a\n1000: /b"); err == nil {
		t.Error("a line break in a directory was accepted")
	}
}

func TestWriteFileAtomicReplacesTheFileAsAWhole(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "projects")
	if err := os.WriteFile(path, []byte("1000: /old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(path, []string{"1001: /new", "1000: /old"}); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got, want := readFile(t, path), "1000: /old\n1001: /new\n"; got != want {
		t.Errorf("the file is %q, want %q", got, want)
	}
	if ents := entries(t, dir); len(ents) != 1 || ents[0] != "projects" {
		t.Errorf("the directory keeps %v, want only the file: the temporary one must be renamed", ents)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o644 {
		t.Errorf("mode is %v, want 0644 for a file that xfs_quota reads", fi.Mode().Perm())
	}
}

func TestWriteFileAtomicKeepsTheFileItHad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "projects")
	// The name is a directory: the rename cannot land, and the failure must not
	// leave a half-written file or a temporary one behind.
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(path, []string{"1000: /a"}); err == nil {
		t.Fatal("a write onto a directory was accepted")
	}
	if ents := entries(t, dir); len(ents) != 1 || ents[0] != "projects" {
		t.Errorf("the directory keeps %v after a failed write, want only the name", ents)
	}
}

func TestMountOptionsForPicksTheLongestMountPoint(t *testing.T) {
	table := strings.Join([]string{
		"sysfs /sys sysfs rw 0 0",
		"/dev/sdb1 /srv xfs rw,noatime 0 0",
		"/dev/sdc1 /srv/myrmidon-bots xfs rw,prjquota 0 0",
		"/dev/sdd1 /srv/myrmidon-bots/other xfs rw,pquota 0 0",
		"/dev/sde1 /srv/sp\\040ace xfs rw,prjquota 0 0",
		"",
	}, "\n")
	for _, tc := range []struct {
		path string
		opts string
		ok   bool
	}{
		{"/srv/myrmidon-bots", "rw,prjquota", true},
		{"/srv/myrmidon-bots/bot-001", "rw,prjquota", true},
		{"/srv/myrmidon-bots/other/bot", "rw,pquota", true},
		{"/srv/backup", "rw,noatime", true},
		{"/srv/sp ace/bot", "rw,prjquota", true},
		{"/srv/myrmidon-bots2", "rw,noatime", true},
		{"/elsewhere", "", false},
	} {
		opts, ok := MountOptionsFor(table, tc.path)
		if opts != tc.opts || ok != tc.ok {
			t.Errorf("mount options of %s are (%q, %v), want (%q, %v)", tc.path, opts, ok, tc.opts, tc.ok)
		}
	}
}

func TestQuotaEnabledReadsTheMountTable(t *testing.T) {
	h := newHost(t, false)
	on, derr := h.a.QuotaEnabled()
	if derr != nil || on {
		t.Errorf("without prjquota: (%v, %v), want (false, nil)", on, derr)
	}
	h.setPrjQuota(true)
	if on, derr = h.a.QuotaEnabled(); derr != nil || !on {
		t.Errorf("with prjquota: (%v, %v), want (true, nil)", on, derr)
	}
	if err := os.Remove(h.mounts); err != nil {
		t.Fatal(err)
	}
	_, derr = h.a.QuotaEnabled()
	wantDeny(t, derr, deny.UpstreamError, http.StatusInternalServerError)
}

func TestProjectNameAndDirOf(t *testing.T) {
	a := New("/srv/bots")
	if got, want := a.DirOf("bot-001"), "/srv/bots/bot-001"; got != want {
		t.Errorf("dir is %q, want %q", got, want)
	}
	if got, want := ProjectName("bot-001"), "myrmidon-bot-001"; got != want {
		t.Errorf("name is %q, want %q", got, want)
	}
	if a.Files.ProjectsFile != ProjectsFile || a.Files.ProjidFile != ProjidFile {
		t.Errorf("the defaults are %q and %q, want %q and %q", a.Files.ProjectsFile, a.Files.ProjidFile, ProjectsFile, ProjidFile)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}

func entries(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir %s: %v", dir, err)
	}
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}
