package gate_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/disk"
)

// A15: PUT /myrmidon/disk/<botKey>/quota. The fixtures of contract C5 are the
// request and the answer of the first test.

const contractDir = "../../../../docs/myrmidon/bot-disk-contract/"

func contractFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(contractDir + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// xfsFake is the Executor: a journal of the calls, and the answer to the state
// query.
type xfsFake struct {
	mu    sync.Mutex
	state string
	calls []string
}

func (f *xfsFake) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, strings.Join(append([]string{name}, args...), "|"))
	for _, a := range args {
		if a == "state -p" {
			return []byte(f.state), nil
		}
	}
	return nil, nil
}

func (f *xfsFake) journal() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// putStub is a DiskQuota with a fixed answer that keeps what it was asked.
type putStub struct {
	mu   sync.Mutex
	res  disk.Result
	err  error
	keys []string
	hard []int64
}

func (p *putStub) Put(_ context.Context, botKey string, hard int64) (disk.Result, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.keys = append(p.keys, botKey)
	p.hard = append(p.hard, hard)
	return p.res, p.err
}

func (p *putStub) asked() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.keys)
}

func quotaTarget(key string) string { return "/myrmidon/disk/" + key + "/quota" }

func TestA15_ValidPutRunsXfsQuotaAndAnswersC5(t *testing.T) {
	const volumeRoot = "/srv/test-bots"
	dir := t.TempDir()
	fx := &xfsFake{state: "  Accounting: ON\n  Enforcement: ON\n"}
	q := disk.NewQuota(volumeRoot, fx)
	q.ProjectsFile, q.ProjidFile = filepath.Join(dir, "projects"), filepath.Join(dir, "projid")
	// The volume root of the rig is not the one of the quota: the arguments of
	// xfs_quota are checked against the quota's own.
	r := newRig(t, withDisk(q))

	res := r.send("PUT", quotaTarget(r.key()), jsonHdr, contractFixture(t, "dockergate-quota-put-request.json"))
	wantStatus(t, res, 200)
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q", ct)
	}
	got := decodeObject(t, res.Body)
	want := decodeObject(t, contractFixture(t, "dockergate-quota-put-response.json"))
	// The fixture's project id is an example; the first id of a fresh /etc/projid
	// is FirstProjectID. Everything else is the fixture.
	want["projectId"] = float64(disk.FirstProjectID)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("answer %v, want %v", got, want)
	}

	wantCalls := []string{
		"xfs_quota|-x|-c|state -p|" + volumeRoot,
		"xfs_quota|-x|-c|project -s -p " + volumeRoot + "/" + r.key() + " 1000|-c|limit -p bhard=6442450944 bsoft=5153960755 1000|" + volumeRoot,
	}
	if j := fx.journal(); !reflect.DeepEqual(j, wantCalls) {
		t.Errorf("xfs_quota calls:\n got  %q\n want %q", j, wantCalls)
	}
	r.wantNoCalls()
	l := r.lastDecision()
	if l.Route != "A15" || l.Decision != "allow" || l.BotKey != r.key() {
		t.Errorf("log line %+v", l)
	}
}

func TestA15_RepeatKeepsProjectID(t *testing.T) {
	st := &putStub{res: disk.Result{ProjectID: 1041, HardBytes: 6442450944}}
	r := newRig(t, withDisk(st))
	body := contractFixture(t, "dockergate-quota-put-request.json")
	for i := 0; i < 2; i++ {
		res := r.send("PUT", quotaTarget(r.key()), jsonHdr, body)
		wantStatus(t, res, 200)
		if got, want := decodeObject(t, res.Body), decodeObject(t, contractFixture(t, "dockergate-quota-put-response.json")); !reflect.DeepEqual(got, want) {
			t.Errorf("answer %d: %v, want %v", i, got, want)
		}
	}
	if !reflect.DeepEqual(st.keys, []string{r.key(), r.key()}) || !reflect.DeepEqual(st.hard, []int64{6442450944, 6442450944}) {
		t.Errorf("asked %v %v", st.keys, st.hard)
	}
}

func TestA15_BytesOutOfRangeIsBadQuota(t *testing.T) {
	st := &putStub{}
	r := newRig(t, withDisk(st))
	for _, b := range []string{
		`{"bytes":0}`, `{"bytes":1}`, `{"bytes":-5}`, `{"bytes":67108863}`,
		`{"bytes":1099511627777}`, `{"bytes":9007199254740991}`,
		// More than the strict parser reads at all: still outside the bounds.
		`{"bytes":1152921504606846976}`, `{"bytes":99999999999999999999}`,
	} {
		wantDeny(t, r.send("PUT", quotaTarget(r.key()), jsonHdr, []byte(b)), deny.BadQuota)
	}
	if n := st.asked(); n != 0 {
		t.Errorf("the quota code was asked %d times", n)
	}
	r.wantNoCalls()
}

func TestA15_BodyShape(t *testing.T) {
	st := &putStub{}
	r := newRig(t, withDisk(st))
	for _, tc := range []struct{ body, code string }{
		{`{}`, deny.JSONType},
		{`[]`, deny.JSONType},
		{`{"bytes":"1073741824"}`, deny.JSONType},
		{`{"bytes":1073741824.5}`, deny.JSONType},
		{`{"bytes":null}`, deny.JSONType},
		{`{"bytes":1073741824,"extra":1}`, deny.JSONUnknownKey},
		{`{"bytes":1073741824,"bytes":1073741824}`, deny.JSONDuplicateKey},
		{`{"bytes":1073741824`, deny.JSONSyntax},
		{``, deny.JSONSyntax},
	} {
		res := r.send("PUT", quotaTarget(r.key()), jsonHdr, []byte(tc.body))
		if got := denyCode(res); got != tc.code {
			t.Errorf("%q: %q, want %q (status %d)", tc.body, got, tc.code, res.Status)
		}
	}
	if n := st.asked(); n != 0 {
		t.Errorf("the quota code was asked %d times", n)
	}
}

func TestA15_ContentTypeIsRequired(t *testing.T) {
	st := &putStub{}
	r := newRig(t, withDisk(st))
	body := []byte(`{"bytes":1073741824}`)
	wantDeny(t, r.send("PUT", quotaTarget(r.key()), nil, body), deny.ContentType)
	wantDeny(t, r.send("PUT", quotaTarget(r.key()), map[string]string{"Content-Type": "text/plain"}, body), deny.ContentType)
	if n := st.asked(); n != 0 {
		t.Errorf("the quota code was asked %d times", n)
	}
}

func TestA15_BadKeyOrMethodIsDenied(t *testing.T) {
	st := &putStub{}
	r := newRig(t, withDisk(st))
	body := []byte(`{"bytes":1073741824}`)
	for _, target := range []string{
		"/myrmidon/disk/../quota",
		"/myrmidon/disk/" + r.key() + "/../quota",
		"/myrmidon/disk/..%2f" + r.key() + "/quota",
		"/myrmidon/disk/bot-001/quota",
		"/myrmidon/disk/" + strings.ToUpper(r.key()) + "/quota",
		"/myrmidon/disk/" + r.key() + "/quota?x=1",
		"/myrmidon/disk//quota",
	} {
		wantDeny(t, r.send("PUT", target, jsonHdr, body), deny.RouteNotAllowed)
	}
	for _, m := range []string{"GET", "POST", "DELETE"} {
		wantDeny(t, r.send(m, quotaTarget(r.key()), nil, nil), deny.RouteNotAllowed)
	}
	if n := st.asked(); n != 0 {
		t.Errorf("the quota code was asked %d times", n)
	}
	r.wantNoCalls()
}

func TestA15_BotNotEnrolledIsDenied(t *testing.T) {
	st := &putStub{}
	r := newRig(t, withDisk(st))
	wantDeny(t, r.send("PUT", quotaTarget(otherKey), jsonHdr, []byte(`{"bytes":1073741824}`)), deny.BotNotEnrolled)
	if n := st.asked(); n != 0 {
		t.Errorf("the quota code was asked %d times", n)
	}
}

func TestA15_QuotaUnavailable(t *testing.T) {
	// Through the real quota code: prjquota is off on the partition.
	dir := t.TempDir()
	fx := &xfsFake{state: "  Accounting: OFF\n  Enforcement: OFF\n"}
	q := disk.NewQuota("/srv/test-bots", fx)
	q.ProjectsFile, q.ProjidFile = filepath.Join(dir, "projects"), filepath.Join(dir, "projid")
	r := newRig(t, withDisk(q))
	res := r.send("PUT", quotaTarget(r.key()), jsonHdr, []byte(`{"bytes":1073741824}`))
	wantDeny(t, res, deny.QuotaUnavailable)
	if res.Status != 503 {
		t.Errorf("status %d, want 503", res.Status)
	}
	if n := len(fx.journal()); n != 1 {
		t.Errorf("only the state may be asked: %q", fx.journal())
	}
	if _, err := os.Stat(q.ProjidFile); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("projid was written")
	}
}

func TestA15_HostFailureIsUpstreamError(t *testing.T) {
	st := &putStub{err: errors.New("xfs_quota: exit status 1")}
	r := newRig(t, withDisk(st))
	res := r.send("PUT", quotaTarget(r.key()), jsonHdr, []byte(`{"bytes":1073741824}`))
	wantDeny(t, res, deny.UpstreamError)
	if strings.Contains(r.log.String(), "exit status") {
		t.Errorf("the log carries the text of the host error")
	}
}
