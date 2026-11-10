package gate_test

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fakedocker"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/gate"
)

// A22 (OPE-12654): the decommission delete of a bot's main container, its
// leftovers, its data directory and its quota project. A variant of A9 for the
// main container the way A17 is a variant of A10.

const a22Tail = "?force=true&v=true&myrmidon-decommission=true"

// a22Rig is a rig whose volume root is a temporary directory that holds the
// bot's data directory, with a quota stub that keeps what it was asked: the
// tests never reach the host's /etc/projid or xfs_quota.
func a22Rig(t *testing.T) (*rig, *putStub, string) {
	t.Helper()
	volumeRoot := t.TempDir()
	st := &putStub{}
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
	for _, event := range []string{"bot_data_removed", "bot_data_remove_failed", "disk_project_removed", "disk_project_remove_failed"} {
		if l := a22Event(t, r, event); l != nil {
			t.Errorf("logged %s: %+v", event, *l)
		}
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
			if pathExists(t, data) {
				t.Error("the bot data directory is still there")
			}
			if !pathExists(t, filepath.Dir(data)) {
				t.Error("the volume root itself was removed")
			}
			if got := quotaRemoved(st); !reflect.DeepEqual(got, []string{r.key()}) {
				t.Errorf("quota projects removed %v", got)
			}
			if ev := a22Event(t, r, "bot_data_removed"); ev == nil || ev.BotKey != r.key() || ev.Detail != "" {
				t.Errorf("bot_data_removed line: %+v", ev)
			}
			if ev := a22Event(t, r, "bot_data_remove_failed"); ev != nil {
				t.Errorf("bot_data_remove_failed logged: %+v", *ev)
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
	if pathExists(t, data) {
		t.Error("the bot data directory is still there")
	}
	if got := quotaRemoved(st); !reflect.DeepEqual(got, []string{r.key()}) {
		t.Errorf("quota projects removed %v", got)
	}
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

// A main container that is gone already: the daemon's 404, and the data stays
// (the gate only removes it after it deleted the container it verified as ours).
func TestAllow_A22_MissingMainIs404AndKeepsTheData(t *testing.T) {
	r, st, data := a22Rig(t)
	res := r.send("DELETE", r.target("", a22Tail), nil, nil)
	wantStatus(t, res, 404)
	if res.str() != `{"message":"No such container"}` {
		t.Errorf("body %q", res.str())
	}
	a22WantUntouched(t, r, st, data, false)
}

// The data removal fails soft: the container delete is answered as the daemon
// answered it, and bot_data_remove_failed names the reason in the fixed
// vocabulary. Here a link stands in place of the bot directory; it is never
// followed. (In production the reason is read_only while the volume root is
// mounted read-only into the gate.)
func TestAllow_A22_DataRemovalFailureIsSoft(t *testing.T) {
	volumeRoot := t.TempDir()
	target := t.TempDir()
	keep := filepath.Join(target, "keep")
	if err := os.WriteFile(keep, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	st := &putStub{}
	r := newRig(t, withDisk(st), withConfig(func(c *config.Config) { c.VolumeRoot = volumeRoot }))
	if err := os.Symlink(target, filepath.Join(volumeRoot, r.key())); err != nil {
		t.Fatal(err)
	}
	r.seedMain("exited")
	wantStatus(t, r.send("DELETE", r.target("", a22Tail), nil, nil), 204)
	r.lastDecision()
	if _, ok := r.d.Get(r.name("")); ok {
		t.Error("the main container is still there")
	}
	if !pathExists(t, keep) || !pathExists(t, filepath.Join(volumeRoot, r.key())) {
		t.Error("the link or what it points at was touched")
	}
	ev := a22Event(t, r, "bot_data_remove_failed")
	if ev == nil || ev.Level != gate.LevelError || ev.BotKey != r.key() || ev.Detail != "not_a_directory" {
		t.Errorf("bot_data_remove_failed line: %+v", ev)
	}
	if ev := a22Event(t, r, "bot_data_removed"); ev != nil {
		t.Errorf("bot_data_removed logged: %+v", *ev)
	}
	// The quota project is still asked to go; the real quota code refuses while
	// the directory exists (disk.Quota.Remove), which is the right answer here.
	if got := quotaRemoved(st); !reflect.DeepEqual(got, []string{r.key()}) {
		t.Errorf("quota projects removed %v", got)
	}
}

// A9 keeps its meaning: without a .next replacement the plain delete of the
// main container is still refused, decommission or not.
func TestDeny_A9_MainWithoutReplacementStaysRefused(t *testing.T) {
	r, st, data := a22Rig(t)
	r.seedMain("exited")
	wantDeny(t, r.send("DELETE", r.target("", "?force=true&v=true"), nil, nil), deny.StatePrecondition)
	a22WantUntouched(t, r, st, data, true)
}
