package gate_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/disk"
)

// A14, GET /myrmidon/disk: the host side (statfs, xfs_quota, /etc/projid) is
// replaced; the daemon is never called.

const diskKey = "0a1b2c3d-0000-4000-8000-00000000000a"

// diskDeps is a partition of 1000 blocks of 4 KiB, 55 % used.
func diskDeps(run disk.Runner) (disk.Deps, *diskSpy) {
	spy := &diskSpy{}
	return disk.Deps{
		Statfs: func(path string) (disk.Fs, error) {
			spy.add("statfs " + path)
			return disk.Fs{BlockSize: 4096, Blocks: 1000, Free: 450, FreeRoot: 450}, nil
		},
		Run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			spy.add("run " + name + " " + strings.Join(args, " "))
			return run(ctx, name, args...)
		},
		ReadFile: func(string) ([]byte, error) { return []byte(diskKey + ":1041\n"), nil },
		Now:      func() time.Time { return time.Date(2026, 10, 6, 14, 8, 0, 0, time.UTC) },
	}, spy
}

type diskSpy struct {
	mu    sync.Mutex
	calls []string
}

func (s *diskSpy) add(c string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, c)
}

func (s *diskSpy) list() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.calls...)
}

func TestDisk_A14_Answer(t *testing.T) {
	deps, spy := diskDeps(func(context.Context, string, ...string) ([]byte, error) {
		return []byte("#0   100   0   0  00 [--------]\n" + diskKey + "  6144  5120  6144  00 [--------]\n"), nil
	})
	r := newRig(t, withDisk(deps))
	res := r.send("GET", "/myrmidon/disk", nil, nil)
	if res.Status != http.StatusOK || res.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("%d %v %s", res.Status, res.Header, res.str())
	}
	var got disk.Response
	if err := json.Unmarshal(res.Body, &got); err != nil {
		t.Fatal(err)
	}
	if !got.QuotaEnabled || got.At != "2026-10-06T14:08:00Z" {
		t.Errorf("%+v", got)
	}
	if got.Partition.Mount != r.cfg.VolumeRoot || got.Partition.TotalBytes != 4096000 || got.Partition.UsedBytes != 550*4096 ||
		got.Partition.FreeBytes != 450*4096 || got.Partition.UsedPercent != 55 {
		t.Errorf("partition %+v", got.Partition)
	}
	if len(got.Projects) != 1 || got.Projects[0] != (disk.Project{BotKey: diskKey, ProjectID: 1041, UsedBytes: 6144 * 1024, SoftBytes: 5120 * 1024, HardBytes: 6144 * 1024}) {
		t.Errorf("projects %+v", got.Projects)
	}
	if got.Other.UsedBytes != 100*1024 {
		t.Errorf("other %+v", got.Other)
	}
	want := []string{
		"statfs " + r.cfg.VolumeRoot,
		"run /usr/sbin/xfs_quota -x -c report -p -b -N " + r.cfg.VolumeRoot,
	}
	if calls := spy.list(); strings.Join(calls, "|") != strings.Join(want, "|") {
		t.Errorf("host calls %q, want %q", calls, want)
	}
	r.wantNoCalls()
	if l := r.lastDecision(); l.Route != "A14" || l.Decision != "allow" || l.Target != "/myrmidon/disk" {
		t.Errorf("decision %+v", l)
	}
}

func TestDisk_A14_QuotaOffIs200(t *testing.T) {
	deps, _ := diskDeps(func(context.Context, string, ...string) ([]byte, error) {
		return nil, errors.New("exit status 1")
	})
	r := newRig(t, withDisk(deps))
	res := r.send("GET", "/myrmidon/disk", nil, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("%d %s", res.Status, res.str())
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(res.Body, &m); err != nil {
		t.Fatal(err)
	}
	if string(m["quotaEnabled"]) != "false" || string(m["projects"]) != "[]" || string(m["other"]) != `{"usedBytes":0}` {
		t.Errorf("%s", res.str())
	}
}

func TestDisk_A14_HostFailures(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*disk.Deps)
		status int
		detail string
	}{
		{"statfs fails", func(d *disk.Deps) {
			d.Statfs = func(string) (disk.Fs, error) { return disk.Fs{}, errors.New("boom") }
		}, http.StatusBadGateway, "statfs"},
		{"unreadable report", func(d *disk.Deps) {
			d.Run = func(context.Context, string, ...string) ([]byte, error) { return []byte("not a report\n"), nil }
		}, http.StatusBadGateway, "xfs_report"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deps, _ := diskDeps(func(context.Context, string, ...string) ([]byte, error) { return nil, nil })
			tc.mutate(&deps)
			r := newRig(t, withDisk(deps))
			res := r.send("GET", "/myrmidon/disk", nil, nil)
			if res.Status != tc.status || denyCode(res) != deny.UpstreamError {
				t.Fatalf("%d %s", res.Status, res.str())
			}
			if l := r.lastDecision(); l.Detail != tc.detail || l.Route != "A14" {
				t.Errorf("decision %+v", l)
			}
		})
	}
}

func TestDisk_A14_Refused(t *testing.T) {
	deps, spy := diskDeps(func(context.Context, string, ...string) ([]byte, error) { return nil, nil })
	r := newRig(t, withDisk(deps))
	for _, tc := range []struct{ method, target string }{
		{"POST", "/myrmidon/disk"},
		{"PUT", "/myrmidon/disk"},
		{"DELETE", "/myrmidon/disk"},
		{"GET", "/myrmidon/disk?x=1"},
		{"GET", "/myrmidon/disk/"},
		{"PUT", "/myrmidon/disk/" + diskKey + "/quota"},
		{"GET", "/v1.45/myrmidon/disk"},
	} {
		res := r.send(tc.method, tc.target, nil, nil)
		if res.Status != http.StatusForbidden || denyCode(res) != deny.RouteNotAllowed {
			t.Errorf("%s %s: %d %s", tc.method, tc.target, res.Status, res.str())
		}
	}
	// A body on A14 is refused before anything runs.
	res := r.send("GET", "/myrmidon/disk", map[string]string{"Content-Type": "application/json"}, []byte("{}"))
	if denyCode(res) != deny.BodyNotAllowed {
		t.Errorf("body: %d %s", res.Status, res.str())
	}
	if calls := spy.list(); len(calls) != 0 {
		t.Errorf("the host was touched by a refused request: %q", calls)
	}
	r.wantNoCalls()
}
