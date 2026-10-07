package gate_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/disk"
)

// A15: the disk quota of one bot (BOT-DISK-H9b, contract C5). The fixtures of
// the contract are the ones that H0 put into docs/myrmidon/bot-disk-contract,
// and the case that the task is about: the body, the command of the host, the
// two files of the mapping, and the two refusals.

const (
	botDiskDir   = "../../../../docs/myrmidon/bot-disk-contract"
	quotaAnsFile = "dockergate-quota-put-response.json"
)

func quotaBody(bytes int64) []byte {
	return []byte(`{"bytes":` + strconv.FormatInt(bytes, 10) + `}`)
}

// contractFixture reads one fixture of the disk contract as an object.
func contractFixture(t testing.TB, name string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(botDiskDir, name))
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return m
}

func TestA15_AppliesTheQuotaOfTheBot(t *testing.T) {
	r := newRig(t)
	res := r.send("PUT", r.quotaTarget(), jsonHdr, quotaBody(6<<30))
	wantStatus(t, res, 200)
	wantNoCanary(t, res)
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q", ct)
	}

	// The answer carries the fields of C5 and nothing else, and their names
	// are the ones of the fixture of the contract.
	const id = disk.FirstProjectID
	dir := r.cfg.VolumeRoot + "/" + r.key()
	ans := decodeObject(t, res.Body)
	wantKeys(t, "the answer of A15", ans, "ok", "projectId", "hardBytes")
	wantKeys(t, "the fixture of C5", contractFixture(t, quotaAnsFile), "ok", "projectId", "hardBytes")
	if ans["ok"] != true {
		t.Errorf("ok is %v, want true", ans["ok"])
	}
	if got := ans["projectId"]; got != float64(id) {
		t.Errorf("projectId is %v, want %d", got, id)
	}
	if got := ans["hardBytes"]; got != float64(6<<30) {
		t.Errorf("hardBytes is %v, want %d", got, 6<<30)
	}

	// One command of the host, with the project of the bot and both limits.
	want := "xfs_quota -x -c project -s -p " + dir + " " + strconv.Itoa(id) +
		" -c limit -p bhard=6442450944 bsoft=5153960755 " + strconv.Itoa(id)
	if got := r.quotaCommand(); got != want {
		t.Errorf("the host saw\n  %s\nwant\n  %s", got, want)
	}

	// The mapping of the bot in the two files of the host.
	if got, want := r.projectsFile(), strconv.Itoa(id)+": "+dir+"\n"; got != want {
		t.Errorf("projects holds %q, want %q", got, want)
	}
	if got, want := r.projidFile(), disk.ProjectName(r.key())+": "+strconv.Itoa(id)+"\n"; got != want {
		t.Errorf("projid holds %q, want %q", got, want)
	}

	// Nothing of the daemon is involved, and the decision is logged.
	r.wantNoCalls()
	if l := r.lastDecision(); l.Route != "A15" || l.Decision != "allow" || l.BotKey != r.key() {
		t.Errorf("the decision is %+v, want A15 allow for %s", l, r.key())
	}
}

func TestA15_KeepsTheProjectIDOfTheBot(t *testing.T) {
	r := newRig(t)
	first := decodeObject(t, r.send("PUT", r.quotaTarget(), jsonHdr, quotaBody(6<<30)).Body)
	res := r.send("PUT", r.quotaTarget(), jsonHdr, quotaBody(8<<30))
	wantStatus(t, res, 200)
	second := decodeObject(t, res.Body)
	if first["projectId"] != second["projectId"] {
		t.Errorf("the Id moved from %v to %v", first["projectId"], second["projectId"])
	}

	// The bot has one line in each file, and the second command raises the
	// limit of the same Id.
	if n := strings.Count(r.projectsFile(), "\n"); n != 1 {
		t.Errorf("projects holds %d lines: %q", n, r.projectsFile())
	}
	if n := strings.Count(r.projidFile(), "\n"); n != 1 {
		t.Errorf("projid holds %d lines: %q", n, r.projidFile())
	}
	calls := r.quotaCalls()
	if len(calls) != 2 {
		t.Fatalf("xfs_quota ran %d times, want 2", len(calls))
	}
	if got, want := calls[1].Name+" "+strings.Join(calls[1].Args, " "), r.quotaCommandOf(8<<30, 6871947673); got != want {
		t.Errorf("the second command is\n  %s\nwant\n  %s", got, want)
	}
}

// quotaCommandOf is the command that an apply of bytes must produce.
func (r *rig) quotaCommandOf(bytes, soft int64) string {
	id := strconv.Itoa(disk.FirstProjectID)
	return "xfs_quota -x -c project -s -p " + r.cfg.VolumeRoot + "/" + r.key() + " " + id +
		" -c limit -p bhard=" + strconv.FormatInt(bytes, 10) + " bsoft=" + strconv.FormatInt(soft, 10) + " " + id
}

func TestA15_RefusesAQuotaOutsideTheBounds(t *testing.T) {
	cases := []struct {
		name string
		body string
		code string
	}{
		{"below the minimum", `{"bytes":67108863}`, deny.BadQuota},
		{"above the maximum", `{"bytes":1099511627777}`, deny.BadQuota},
		{"zero", `{"bytes":0}`, deny.BadQuota},
		{"negative", `{"bytes":-1}`, deny.BadQuota},
		{"not an integer", `{"bytes":1.5}`, deny.JSONType},
		{"a string", `{"bytes":"6442450944"}`, deny.JSONType},
		{"not an object", `[6442450944]`, deny.JSONType},
		{"no bytes", `{}`, deny.JSONSyntax},
		{"another key", `{"limit":1}`, deny.JSONUnknownKey},
		{"broken", `{"bytes":`, deny.JSONSyntax},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t)
			res := r.send("PUT", r.quotaTarget(), jsonHdr, []byte(c.body))
			wantDenyStatus(t, res, deny.StatusFor(c.code), c.code)
			// C5 pins the status of the code of the contract itself: a quota
			// outside the bounds is a bad request, not a forbidden one.
			if c.code == deny.BadQuota && res.Status != 400 {
				t.Errorf("status %d for bad_quota, want 400", res.Status)
			}
			wantNoCanary(t, res)
			// Neither the host nor the daemon was touched.
			r.wantNoCalls()
			if n := len(r.quotaCalls()); n != 0 {
				t.Errorf("xfs_quota ran %d times", n)
			}
			if f := r.projectsFile(); f != "" {
				t.Errorf("projects was written: %q", f)
			}
			if f := r.projidFile(); f != "" {
				t.Errorf("projid was written: %q", f)
			}
		})
	}
}

func TestA15_QuotaUnavailableWithoutPrjQuota(t *testing.T) {
	r := newRig(t)
	r.setPrjQuota(false)
	res := r.send("PUT", r.quotaTarget(), jsonHdr, quotaBody(6<<30))
	wantDenyStatus(t, res, 503, deny.QuotaUnavailable)
	wantNoCanary(t, res)
	r.wantNoCalls()
	if n := len(r.quotaCalls()); n != 0 {
		t.Errorf("xfs_quota ran %d times without prjquota", n)
	}
	if f := r.projectsFile(); f != "" {
		t.Errorf("projects was written: %q", f)
	}
}

func TestA15_BotKeyIsCheckedBeforeTheBody(t *testing.T) {
	r := newRig(t)
	// The body is valid: the route must still refuse the request, and it
	// must refuse it before the host is asked anything.
	for _, target := range []string{
		"/v1.45/myrmidon/disk/../quota",
		"/v1.45/myrmidon/disk/" + r.key()[:35] + "/quota",
		"/v1.45/myrmidon/disk/" + strings.ToUpper(r.key()) + "/quota",
		"/v1.45/myrmidon/disk/" + r.key(),
		"/v1.45/myrmidon/disk/" + r.key() + "/quota/x",
	} {
		t.Run(target, func(t *testing.T) {
			res := r.send("PUT", target, jsonHdr, quotaBody(6<<30))
			wantDenyStatus(t, res, deny.StatusFor(deny.RouteNotAllowed), deny.RouteNotAllowed)
			r.wantNoCalls()
			if n := len(r.quotaCalls()); n != 0 {
				t.Errorf("xfs_quota ran %d times", n)
			}
		})
	}
}
