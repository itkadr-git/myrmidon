package gate_test

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/disk"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fakedocker"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/gate"
)

// A22 (OPE-12654): the decommission delete of a bot's main container and its
// leftovers. The data directory and the quota project are NOT removed here:
// the gate is uid 65532 on a read-only volume root (the ADM hand-off of
// 11.11), so the host GC owns the directory — and the quota entries, which
// Quota.Remove refuses to clear while the directory still exists. A variant of
// A9 for the main container the way A17 is a variant of A10.

const a22Tail = "?force=true&v=true&myrmidon-decommission=true"

// a22Rig is a rig whose volume root is a temporary directory that holds the
// bot's data directory, with a quota stub that keeps what it was asked and
// refuses like the real Quota.Remove does while the directory still exists
// (disk.ErrBotDirStillExists is its typed refusal): the tests never reach the
// host's /etc/projid or xfs_quota.
func a22Rig(t *testing.T) (*rig, *putStub, string) {
	t.Helper()
	volumeRoot := t.TempDir()
	st := &putStub{err: disk.ErrBotDirStillExists}
	r := newRig(t, withDisk(st), withConfig(func(c *config.Config) { c.VolumeRoot = volumeRoot }))
	data := filepath.Join(volumeRoot, r.key())
	for _, f := range []string{"hermes/sessions/s1.json", "workspace/repo/.git/HEAD", "scratch/tmp.txt"} {
		p := filepath.Join(data, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return r, st, data
}

func pathExists(t testing.TB, p string) bool {
	t.Helper()
	_, err := os.Lstat(p)
	if err == nil {
		return true
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	return false
}

// quotaRemoved is what the quota stub was asked to remove.
func quotaRemoved(st *putStub) []string {
	st.mu.Lock()
	defer st.mu.Unlock()
	return append([]string(nil), st.removeKeys...)
}

// a22Event is the first log line of the event, or nil.
func a22Event(t *testing.T, r *rig, event string) *gate.Line {
	t.Helper()
	for _, l := range r.log.Lines(t) {
		if l.Event == event {
			found := l
			return &found
		}
	}
	return nil
}

// a22WantUntouched: nothing but inspects reached the daemon, the main
// container is there when it was seeded, the data directory is in place and no
// quota project was removed. The decision line is waited for first: the gate
// writes it when the request is over.
func a22WantUntouched(t *testing.T, r *rig, st *putStub, data string, mainSeeded bool) {
	t.Helper()
	r.lastDecision()
	for _, u := range r.uris() {
		if !strings.HasPrefix(u, "GET ") {
			t.Errorf("a changing call reached the daemon: %s", u)
		}
	}
	if _, ok := r.d.Get(r.name("")); ok != mainSeeded {
		t.Errorf("main container present: %v, want %v", ok, mainSeeded)
	}
	if !pathExists(t, data) {
		t.Error("the bot data directory was removed")
	}
	if got := quotaRemoved(st); len(got) != 0 {
		t.Errorf("quota projects removed: %v", got)
	}
	for _, event := range []string{
		"bot_data_removed", "bot_data_remove_failed",
		"bot_data_left_for_host_gc", "quota_left_for_host_gc",
		"disk_project_removed", "disk_project_remove_failed", "disk_project_still_has_directory",
	} {
		if l := a22Event(t, r, event); l != nil {
			t.Errorf("logged %s: %+v", event, *l)
		}
	}
}

// a22WantHandedToHostGC: the decommission delete went through, the data
// directory stays and is handed to the host GC by name, and the quota stub was
// asked and refused (the stub stands in for Quota.Remove, which refuses while
// the directory exists).
func a22WantHandedToHostGC(t *testing.T, r *rig, st *putStub, data string) {
	t.Helper()
	if !pathExists(t, data) {
		t.Fatal("the bot data directory was removed by the gate")
	}
	if got := quotaRemoved(st); !reflect.DeepEqual(got, []string{r.key()}) {
		t.Errorf("quota projects asked: %v, want [%s]", got, r.key())
	}
	ev := a22Event(t, r, "bot_data_left_for_host_gc")
	if ev == nil || ev.BotKey != r.key() || ev.Detail != "" {
		t.Errorf("bot_data_left_for_host_gc line: %+v", ev)
	}
	if ev := a22Event(t, r, "disk_project_removed"); ev != nil {
		t.Errorf("disk_project_removed logged: %+v", *ev)
	}
	if ev := a22Event(t, r, "disk_project_remove_failed"); ev != nil {
		t.Errorf("disk_project_remove_failed logged: %+v", *ev)
	}
	if ev := a22Event(t, r, "disk_project_still_has_directory"); ev == nil || ev.Level != gate.LevelInfo {
		t.Errorf("disk_project_still_has_directory line: %+v", ev)
	}
	if ev := a22Event(t, r, "quota_left_for_host_gc"); ev == nil || ev.BotKey != r.key() {
		t.Errorf("quota_left_for_host_gc line: %+v", ev)
	}
}

func TestAllow_A22_DecommissionOfAStoppedMain(t *testing.T) {
	for _, status := range []string{"created", "exited", "dead"} {
		t.Run(status, func(t *testing.T) {
			r, st, data := a22Rig(t)
			r.seedMain(status)
			id := r.id("")
			res := r.send("DELETE", r.target("", a22Tail), nil, nil)
			wantStatus(t, res, 204)
			l := r.lastDecision()
			if l.Route != "A22" || l.Decision != "allow" || l.BotKey != r.key() {
				t.Errorf("decision line %+v", l)
			}
			if _, ok := r.d.Get(r.name("")); ok {
				t.Error("the main container is still there")
			}
			// The daemon gets the plain delete the gate builds, by the Id of its own inspect.
			r.wantURIs("GET "+r.target("", "/json"), "GET "+r.target(".next", "/json"), "GET "+r.target(".helper", "/json"),
				"DELETE /v1.45/containers/"+id+"?force=true&v=true")
			r.wantDaemonHeaders()
			a22WantHandedToHostGC(t, r, st, data)
			if !pathExists(t, filepath.Dir(data)) {
				t.Error("the volume root itself was removed")
			}
		})
	}
}

func TestDeny_A22_RunningMain(t *testing.T) {
	for _, status := range []string{"running", "restarting", "paused"} {
		t.Run(status, func(t *testing.T) {
			r, st, data := a22Rig(t)
			r.seedMain(status)
			wantDeny(t, r.send("DELETE", r.target("", a22Tail), nil, nil), deny.StatePrecondition)
			a22WantUntouched(t, r, st, data, true)
		})
	}
}

func TestDeny_A22_RunningNextOrHelperBlocks(t *testing.T) {
	for _, tc := range []struct {
		name string
		sfx  string
		seed func(r *rig)
	}{
		{"running .next", ".next", func(r *rig) { r.seedNext("running") }},
		{"running prepare helper", ".helper", func(r *rig) { r.seedPrepareHelper("running") }},
		{"running apply helper", ".helper", func(r *rig) { r.seedApplyHelper("0123456789abcdef", "running") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, st, data := a22Rig(t)
			r.seedMain("exited")
			tc.seed(r)
			wantDeny(t, r.send("DELETE", r.target("", a22Tail), nil, nil), deny.StatePrecondition)
			a22WantUntouched(t, r, st, data, true)
			if _, ok := r.d.Get(r.name(tc.sfx)); !ok {
				t.Errorf("%s is gone", tc.sfx)
			}
		})
	}
}

// The leftovers of an interrupted recreate (.next, created) or apply (a helper
// that exited) go first, then the main container: no container of the bot
// outlives the decommission.
func TestAllow_A22_RemovesTheLeftoversOfAnInterruptedRecreateOrApply(t *testing.T) {
	r, st, data := a22Rig(t)
	r.seedMain("exited")
	r.seedNext("created")
	r.seedPrepareHelper("exited")
	mainID, nextID, helperID := r.id(""), r.id(".next"), r.id(".helper")
	wantStatus(t, r.send("DELETE", r.target("", a22Tail), nil, nil), 204)
	r.lastDecision()
	for _, sfx := range []string{"", ".next", ".helper"} {
		if _, ok := r.d.Get(r.name(sfx)); ok {
			t.Errorf("%q is still there", sfx)
		}
	}
	r.wantURIs("GET "+r.target("", "/json"), "GET "+r.target(".next", "/json"), "GET "+r.target(".helper", "/json"),
		"DELETE /v1.45/containers/"+nextID+"?force=true&v=true",
		"DELETE /v1.45/containers/"+helperID+"?force=true&v=true",
		"DELETE /v1.45/containers/"+mainID+"?force=true&v=true")
	a22WantHandedToHostGC(t, r, st, data)
}

// The route exists for the main container only, and no target can name a key
// outside the lowercase-UUID form: a path that tries to leave the volume root is
// not a route, so it never reaches the inspect, let alone the file system.
func TestDeny_A22_MainContainerOnlyAndNoPathTraversal(t *testing.T) {
	r, st, data := a22Rig(t)
	r.seedMain("exited")
	r.seedNext("created")
	r.seedPrepareHelper("exited")
	for _, target := range []string{
		r.target(".next", a22Tail),
		r.target(".helper", a22Tail),
		"/v1.45/containers/myrmidon-bot-.." + a22Tail,
		"/v1.45/containers/myrmidon-bot-..%2F" + r.key() + a22Tail,
		"/v1.45/containers/myrmidon-bot-%2E%2E" + a22Tail,
		"/v1.45/containers/myrmidon-bot-" + r.key() + "/.." + a22Tail,
		"/v1.45/containers/myrmidon-bot-" + strings.ToUpper(r.key()) + a22Tail,
	} {
		wantDeny(t, r.send("DELETE", target, nil, nil), deny.RouteNotAllowed)
	}
	r.wantNoCalls()
	for _, sfx := range []string{"", ".next", ".helper"} {
		if _, ok := r.d.Get(r.name(sfx)); !ok {
			t.Errorf("%q is gone", sfx)
		}
	}
	if !pathExists(t, data) {
		t.Error("the bot data directory was removed")
	}
	if got := quotaRemoved(st); len(got) != 0 {
		t.Errorf("quota projects removed: %v", got)
	}
}

func TestDeny_A22_ForeignMainIsNotTouched(t *testing.T) {
	r, st, data := a22Rig(t)
	r.d.Seed(fakedocker.Container{Name: r.name(""), Labels: map[string]string{"myrmidon.bot": otherKey}, Status: "exited"})
	wantDeny(t, r.send("DELETE", r.target("", a22Tail), nil, nil), deny.ForeignContainer)
	a22WantUntouched(t, r, st, data, true)
}

// A main container that is gone already: the daemon's 404, and nothing else
// happens — the data directory is the host GC's from the start.
func TestAllow_A22_MissingMainIs404AndKeepsTheData(t *testing.T) {
	r, st, data := a22Rig(t)
	res := r.send("DELETE", r.target("", a22Tail), nil, nil)
	wantStatus(t, res, 404)
	if res.str() != `{"message":"No such container"}` {
		t.Errorf("body %q", res.str())
	}
	a22WantUntouched(t, r, st, data, false)
}

// (Removed with the gate-side data removal, 11.11: the gate is uid 65532 on a
// read-only volume root, so the soft-failure path TestAllow_A22_
// DataRemovalFailureIsSoft had no production path left. The host GC
// (host-clone-cache-gc.mjs) carries the removal failure cases now.)

// A9 keeps its meaning: without a .next replacement the plain delete of the
// main container is still refused, decommission or not.
func TestDeny_A9_MainWithoutReplacementStaysRefused(t *testing.T) {
	r, st, data := a22Rig(t)
	r.seedMain("exited")
	wantDeny(t, r.send("DELETE", r.target("", "?force=true&v=true"), nil, nil), deny.StatePrecondition)
	a22WantUntouched(t, r, st, data, true)
}

// OPE-12959: the result of Disk.Remove after the A9 delete of the main
// container is classified, not blanket-logged as an error. The recreate keeps
// the bot's data directory, so Quota.Remove's typed refusal
// (disk.ErrBotDirStillExists) is the expected case and lands as an info line,
// never as disk_project_remove_failed.
func TestAllow_A9_RecreateWithDataLeftLogsNoError(t *testing.T) {
	r, st, data := a22Rig(t)
	r.seedMain("exited")
	r.seedNext("created")
	res := r.send("DELETE", r.target("", "?force=true&v=true"), nil, nil)
	wantStatus(t, res, 204)
	r.lastDecision()
	if got := quotaRemoved(st); !reflect.DeepEqual(got, []string{r.key()}) {
		t.Errorf("quota projects asked: %v, want [%s]", got, r.key())
	}
	if !pathExists(t, data) {
		t.Error("the bot data directory was removed")
	}
	if ev := a22Event(t, r, "disk_project_remove_failed"); ev != nil {
		t.Errorf("disk_project_remove_failed logged: %+v", *ev)
	}
	if ev := a22Event(t, r, "disk_project_removed"); ev != nil {
		t.Errorf("disk_project_removed logged: %+v", *ev)
	}
	ev := a22Event(t, r, "disk_project_still_has_directory")
	if ev == nil || ev.Level != gate.LevelInfo || ev.BotKey != r.key() {
		t.Errorf("disk_project_still_has_directory line: %+v", ev)
	}
}

// The other side of OPE-12959: a real failure of the removal (here a stub
// error standing in for an unreadable projects file) is logged as an error
// and the cause is kept in Detail.
func TestAllow_A9_RecreateWithFailingRemoveLogsErrorWithCause(t *testing.T) {
	rig := newRig(t, withDisk(&failingRemoveStub{err: errors.New("disk: read /etc/projects: permission denied")}))
	rig.seedMain("exited")
	rig.seedNext("created")
	res := rig.send("DELETE", rig.target("", "?force=true&v=true"), nil, nil)
	wantStatus(t, res, 204)
	rig.lastDecision()
	var fail, still *gate.Line
	for _, l := range rig.log.Lines(t) {
		if l.Event == "disk_project_remove_failed" {
			found := l
			fail = &found
		}
		if l.Event == "disk_project_still_has_directory" {
			found := l
			still = &found
		}
	}
	if still != nil {
		t.Errorf("disk_project_still_has_directory logged: %+v", *still)
	}
	if fail == nil {
		t.Fatal("no disk_project_remove_failed line")
	}
	if fail.Level != gate.LevelError || fail.BotKey != rig.key() || fail.Reason != "delete" {
		t.Errorf("disk_project_remove_failed line: %+v", *fail)
	}
	if !strings.Contains(fail.Detail, "permission denied") {
		t.Errorf("Detail %q has no cause", fail.Detail)
	}
}

// failingRemoveStub refuses Remove like putStub, for the error case of the
// A9 disk cleanup.
type failingRemoveStub struct{ err error }

func (f *failingRemoveStub) Ensure(context.Context, string) (int, error) { return 0, nil }
func (f *failingRemoveStub) Remove(context.Context, string) error         { return f.err }
func (f *failingRemoveStub) Put(context.Context, string, int64) (disk.Result, error) {
	return disk.Result{}, nil
}
