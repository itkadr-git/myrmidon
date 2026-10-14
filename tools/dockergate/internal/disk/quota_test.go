package disk

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const (
	qKeyA = "0a1b2c3d-1111-2222-3333-444455556666"
	qKeyB = "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff"
	root  = "/srv/myrmidon-bots"

	stateOn  = "Project quota state on /srv/myrmidon-bots (/dev/sdb1)\n  Accounting: ON\n  Enforcement: ON\n  Inode: #131 (1 blocks, 1 extents)\n"
	stateOff = "Project quota state on /srv/myrmidon-bots (/dev/sdb1)\n  Accounting: OFF\n  Enforcement: OFF\n"
)

// fakeExec keeps a journal of the calls and answers the state query with state.
type fakeExec struct {
	mu       sync.Mutex
	state    string
	stateErr error
	setErr   error
	calls    [][]string
}

func (f *fakeExec) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, append([]string{name}, args...))
	for _, a := range args {
		if a == "state -p" {
			return []byte(f.state), f.stateErr
		}
	}
	return nil, f.setErr
}

func (f *fakeExec) journal() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.calls))
	for i, c := range f.calls {
		out[i] = strings.Join(c, "|")
	}
	return out
}

func newQuota(t *testing.T, state string) (*Quota, *fakeExec) {
	t.Helper()
	dir := t.TempDir()
	f := &fakeExec{state: state}
	q := NewQuota(root, f)
	q.ProjectsFile = filepath.Join(dir, "projects")
	q.ProjidFile = filepath.Join(dir, "projid")
	return q, f
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestPut_ValidCallsXfsQuotaWithTheContractArguments(t *testing.T) {
	q, f := newQuota(t, stateOn)
	const hard = int64(6442450944)
	res, err := q.Put(context.Background(), qKeyA, hard)
	if err != nil {
		t.Fatal(err)
	}
	if res.ProjectID != FirstProjectID || res.HardBytes != hard {
		t.Fatalf("result %+v", res)
	}
	want := []string{
		"xfs_quota|-x|-c|state -p|" + root,
		"xfs_quota|-x|-c|project -s -p " + root + "/" + qKeyA + " 1000|-c|limit -p bhard=6442450944 bsoft=5153960755 1000|" + root,
	}
	got := f.journal()
	if len(got) != len(want) {
		t.Fatalf("journal %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("call %d: %q, want %q", i, got[i], want[i])
		}
	}
	if s := read(t, q.ProjidFile); s != qKeyA+":1000\n" {
		t.Errorf("projid %q", s)
	}
	if s := read(t, q.ProjectsFile); s != "1000:"+root+"/"+qKeyA+"\n" {
		t.Errorf("projects %q", s)
	}
}

func TestPut_SoftLimitIsEightTenths(t *testing.T) {
	if got := softBytes(MinQuotaBytes); got != 53687091 {
		t.Errorf("soft of 64 MiB: %d", got)
	}
	if got := softBytes(MaxQuotaBytes); got != MaxQuotaBytes*8/10 {
		t.Errorf("soft of 1 TiB: %d", got)
	}
}

func TestPut_BoundsAreInclusive(t *testing.T) {
	for _, n := range []int64{MinQuotaBytes, MaxQuotaBytes} {
		q, _ := newQuota(t, stateOn)
		if _, err := q.Put(context.Background(), qKeyA, n); err != nil {
			t.Errorf("%d: %v", n, err)
		}
	}
}

func TestPut_OutOfRangeIsBadQuotaAndTouchesNothing(t *testing.T) {
	for _, n := range []int64{-1, 0, 1, MinQuotaBytes - 1, MaxQuotaBytes + 1} {
		q, f := newQuota(t, stateOn)
		_, err := q.Put(context.Background(), qKeyA, n)
		if !errors.Is(err, ErrBadQuota) {
			t.Errorf("%d: %v", n, err)
		}
		if len(f.journal()) != 0 {
			t.Errorf("%d: xfs_quota was run: %q", n, f.journal())
		}
		if _, statErr := os.Stat(q.ProjidFile); !errors.Is(statErr, os.ErrNotExist) {
			t.Errorf("%d: projid was written", n)
		}
	}
}

func TestPut_BadKeyIsRefused(t *testing.T) {
	for _, k := range []string{"", "..", "../etc", qKeyA + "/..", strings.ToUpper(qKeyA), "bot-001", qKeyA + "\n"} {
		q, f := newQuota(t, stateOn)
		if _, err := q.Put(context.Background(), k, MinQuotaBytes); !errors.Is(err, ErrBadKey) {
			t.Errorf("%q: %v", k, err)
		}
		if len(f.journal()) != 0 {
			t.Errorf("%q: xfs_quota was run", k)
		}
	}
}

func TestPut_RepeatKeepsTheProjectID(t *testing.T) {
	q, f := newQuota(t, stateOn)
	ctx := context.Background()
	a1, err := q.Put(ctx, qKeyA, MinQuotaBytes)
	if err != nil {
		t.Fatal(err)
	}
	b, err := q.Put(ctx, qKeyB, MinQuotaBytes)
	if err != nil {
		t.Fatal(err)
	}
	a2, err := q.Put(ctx, qKeyA, 2*MinQuotaBytes)
	if err != nil {
		t.Fatal(err)
	}
	if a1.ProjectID != a2.ProjectID {
		t.Errorf("project id of A changed: %d then %d", a1.ProjectID, a2.ProjectID)
	}
	if b.ProjectID == a1.ProjectID {
		t.Errorf("A and B share project id %d", b.ProjectID)
	}
	if a2.HardBytes != 2*MinQuotaBytes {
		t.Errorf("hard %d", a2.HardBytes)
	}
	// The files carry one line per bot, however many times it was put.
	if n := strings.Count(read(t, q.ProjidFile), "\n"); n != 2 {
		t.Errorf("projid has %d lines:\n%s", n, read(t, q.ProjidFile))
	}
	if n := strings.Count(read(t, q.ProjectsFile), "\n"); n != 2 {
		t.Errorf("projects has %d lines:\n%s", n, read(t, q.ProjectsFile))
	}
	// Three puts: each one asks for the state, then sets the project and the limit.
	if n := len(f.journal()); n != 6 {
		t.Errorf("%d xfs_quota runs, want 6: %q", n, f.journal())
	}
}

func TestPut_SameRequestTwiceIsIdempotent(t *testing.T) {
	q, f := newQuota(t, stateOn)
	ctx := context.Background()
	r1, err := q.Put(ctx, qKeyA, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	projid, projects := read(t, q.ProjidFile), read(t, q.ProjectsFile)
	r2, err := q.Put(ctx, qKeyA, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	if r1 != r2 {
		t.Errorf("%+v then %+v", r1, r2)
	}
	if read(t, q.ProjidFile) != projid || read(t, q.ProjectsFile) != projects {
		t.Error("the files changed on the second put")
	}
	j := f.journal()
	if len(j) != 4 || j[1] != j[3] {
		t.Errorf("the set command differs between the runs: %q", j)
	}
}

func TestPut_ExistingFilesAreKeptAndIDsNotReused(t *testing.T) {
	q, _ := newQuota(t, stateOn)
	if err := os.WriteFile(q.ProjidFile, []byte("# bots\nlegacy:1500\nsomebody:12\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(q.ProjectsFile, []byte("1500:/srv/legacy\n1700:/srv/other\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(q.ProjidFile, 0o640); err != nil {
		t.Fatal(err)
	}
	res, err := q.Put(context.Background(), qKeyA, MinQuotaBytes)
	if err != nil {
		t.Fatal(err)
	}
	if res.ProjectID != 1701 {
		t.Errorf("project id %d, want 1701 (above every id in both files)", res.ProjectID)
	}
	if got, want := read(t, q.ProjidFile), "# bots\nlegacy:1500\nsomebody:12\n"+qKeyA+":1701\n"; got != want {
		t.Errorf("projid %q, want %q", got, want)
	}
	if got, want := read(t, q.ProjectsFile), "1500:/srv/legacy\n1700:/srv/other\n1701:"+root+"/"+qKeyA+"\n"; got != want {
		t.Errorf("projects %q, want %q", got, want)
	}
	fi, err := os.Stat(q.ProjidFile)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o640 {
		t.Errorf("mode %v, want 0640 (kept)", fi.Mode().Perm())
	}
}

func TestPut_ExistingNameKeepsItsID(t *testing.T) {
	q, _ := newQuota(t, stateOn)
	if err := os.WriteFile(q.ProjidFile, []byte("other:2000\n"+qKeyA+":1234\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := q.Put(context.Background(), qKeyA, MinQuotaBytes)
	if err != nil {
		t.Fatal(err)
	}
	if res.ProjectID != 1234 {
		t.Errorf("project id %d, want 1234", res.ProjectID)
	}
	if got := read(t, q.ProjectsFile); got != "1234:"+root+"/"+qKeyA+"\n" {
		t.Errorf("projects %q", got)
	}
}

func TestPut_QuotaUnavailable(t *testing.T) {
	cases := map[string]*fakeExec{
		"accounting off":  {state: stateOff},
		"empty state":     {state: ""},
		"xfs_quota fails": {state: stateOn, stateErr: errors.New("exit status 1")},
		"only accounting": {state: "  Accounting: ON\n  Enforcement: OFF\n"},
	}
	for name, f := range cases {
		q := NewQuota(root, f)
		dir := t.TempDir()
		q.ProjectsFile, q.ProjidFile = filepath.Join(dir, "projects"), filepath.Join(dir, "projid")
		_, err := q.Put(context.Background(), qKeyA, MinQuotaBytes)
		if !errors.Is(err, ErrQuotaUnavailable) {
			t.Errorf("%s: %v", name, err)
		}
		if len(f.journal()) != 1 {
			t.Errorf("%s: only the state may be asked, journal %q", name, f.journal())
		}
		for _, p := range []string{q.ProjectsFile, q.ProjidFile} {
			if _, statErr := os.Stat(p); !errors.Is(statErr, os.ErrNotExist) {
				t.Errorf("%s: %s was written", name, p)
			}
		}
	}
}

func TestPut_SetFailureIsNotAQuotaDecision(t *testing.T) {
	q, f := newQuota(t, stateOn)
	f.setErr = errors.New("exit status 1")
	_, err := q.Put(context.Background(), qKeyA, MinQuotaBytes)
	if err == nil || errors.Is(err, ErrQuotaUnavailable) || errors.Is(err, ErrBadQuota) {
		t.Errorf("err %v", err)
	}
}

// The files are replaced by a rename of a temporary file from the same
// directory: no temporary file stays, and the file never has a partial content.
func TestWriteAtomic_ReplacesAndLeavesNoTemporaryFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "projid")
	if err := os.WriteFile(path, []byte("old:1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(path, []byte("new:2\n")); err != nil {
		t.Fatal(err)
	}
	if got := read(t, path); got != "new:2\n" {
		t.Errorf("content %q", got)
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 1 || ents[0].Name() != "projid" {
		names := []string{}
		for _, e := range ents {
			names = append(names, e.Name())
		}
		t.Errorf("the directory has %q, want only projid", names)
	}
}

func TestWriteAtomic_FailedRenameKeepsTheOldFileAndCleansUp(t *testing.T) {
	dir := t.TempDir()
	// A directory with a file inside cannot be replaced by a rename of a file:
	// the rename fails after the temporary file was written.
	path := filepath.Join(dir, "projid")
	if err := os.MkdirAll(filepath.Join(path, "keep"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(path, []byte("new:2\n")); err == nil {
		t.Fatal("want an error")
	}
	if _, err := os.Stat(filepath.Join(path, "keep")); err != nil {
		t.Errorf("the old target changed: %v", err)
	}
	ents, _ := os.ReadDir(dir)
	if len(ents) != 1 {
		t.Errorf("a temporary file stayed: %v", ents)
	}
}

func TestWriteAtomic_NoDirectoryIsAnErrorAndWritesNothing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing", "projid")
	if err := writeAtomic(path, []byte("x\n")); err == nil {
		t.Fatal("want an error")
	}
}

func TestPut_FileWriteFailureStopsBeforeXfsQuota(t *testing.T) {
	q, f := newQuota(t, stateOn)
	q.ProjidFile = filepath.Join(t.TempDir(), "missing", "projid")
	if _, err := q.Put(context.Background(), qKeyA, MinQuotaBytes); err == nil {
		t.Fatal("want an error")
	}
	if n := len(f.journal()); n != 1 {
		t.Errorf("only the state may be asked, journal %q", f.journal())
	}
}
