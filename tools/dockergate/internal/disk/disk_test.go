package disk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	keyA = "0a1b2c3d-0000-4000-8000-00000000000a"
	keyB = "0a1b2c3d-0000-4000-8000-00000000000b"
)

var projids = map[string]uint64{keyA: 1041, keyB: 1042}

func TestParseSize(t *testing.T) {
	tests := []struct {
		in   string
		want uint64
		bad  bool
	}{
		{in: "0", want: 0},
		{in: "1", want: 1024},
		{in: "6291456", want: 6291456 * 1024},
		{in: "512K", want: 512 << 10},
		{in: "512k", want: 512 << 10},
		{in: "1M", want: 1 << 20},
		{in: "5G", want: 5 << 30},
		{in: "5.9G", want: 6335076762},
		{in: "1.5M", want: 1572864},
		{in: "2T", want: 2 << 40},
		{in: "1P", want: 1 << 50},
		{in: "1E", want: 1 << 60},
		{in: "100B", want: 100},
		{in: "", bad: true},
		{in: "G", bad: true},
		{in: "5.G", bad: true},
		{in: ".5G", bad: true},
		{in: "1X", bad: true},
		{in: "-1", bad: true},
		{in: "1e3", bad: true},
		{in: "16E", bad: true},
		{in: "18446744073709551615", bad: true},
	}
	for _, tc := range tests {
		got, err := parseSize(tc.in)
		if tc.bad {
			if err == nil {
				t.Errorf("parseSize(%q) = %d, want an error", tc.in, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("parseSize(%q) = %d, %v; want %d", tc.in, got, err, tc.want)
		}
	}
}

func TestParseReport(t *testing.T) {
	tests := []struct {
		name      string
		out       string
		wantProj  []Project
		wantOther uint64
		wantErr   bool
	}{
		{
			name: "blocks of 1 KiB, rows of bots and project 0",
			out: "#0                  104857600          0          0     00 [--------]\n" +
				keyA + "      6291456    5242880    6291456     00 [--------]\n" +
				keyB + "      1024          0          0     00 [--------]\n",
			wantProj: []Project{
				{BotKey: keyA, ProjectID: 1041, UsedBytes: 6291456 * 1024, SoftBytes: 5242880 * 1024, HardBytes: 6291456 * 1024},
				{BotKey: keyB, ProjectID: 1042, UsedBytes: 1024 * 1024},
			},
			wantOther: 104857600 * 1024,
		},
		{
			name: "human units",
			out: "#0      100M      0      0     00 [--------]\n" +
				keyA + "   5.9G   5G   6G     00 [--------]\n" +
				keyB + "   512K   0    1.5M   00 [--------]\n",
			wantProj: []Project{
				{BotKey: keyA, ProjectID: 1041, UsedBytes: 6335076762, SoftBytes: 5 << 30, HardBytes: 6 << 30},
				{BotKey: keyB, ProjectID: 1042, UsedBytes: 512 << 10, HardBytes: 1572864},
			},
			wantOther: 100 << 20,
		},
		{
			name: "unknown project ids and names outside the project table go to other",
			out: "#0      10      0      0     00 [--------]\n" +
				"#77     20      0      0     00 [--------]\n" +
				"stray   30      0      0     00 [--------]\n" +
				keyA + "   40   0   50     00 [--------]\n",
			wantProj:  []Project{{BotKey: keyA, ProjectID: 1041, UsedBytes: 40 * 1024, HardBytes: 50 * 1024}},
			wantOther: 60 * 1024,
		},
		{
			name:     "no rows",
			out:      "",
			wantProj: []Project{},
		},
		{
			name:     "header lines of a report without -N are skipped",
			out:      "Project quota on /srv/myrmidon-xfs (/dev/vdb1)\n                               Blocks\nProject ID       Used       Soft       Hard    Warn/Grace\n---------- --------------------------------------------------\n" + keyA + "  8  0  0  00 [--------]\n",
			wantProj: []Project{{BotKey: keyA, ProjectID: 1041, UsedBytes: 8 * 1024}},
		},
		{
			name: "grace column with a time is ignored",
			out:  keyA + "  9000  8000  10000  00 [6 days]\n",
			wantProj: []Project{
				{BotKey: keyA, ProjectID: 1041, UsedBytes: 9000 * 1024, SoftBytes: 8000 * 1024, HardBytes: 10000 * 1024},
			},
		},
		{name: "too few fields", out: keyA + "  8  0\n", wantErr: true},
		{name: "bad number", out: keyA + "  8x  0  0  00\n", wantErr: true},
		{name: "same project twice", out: keyA + " 1 0 0 00\n" + keyA + " 2 0 0 00\n", wantErr: true},
		{name: "sum overflow in other", out: "#1 17179869183E 0 0 00\n", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			proj, other, err := ParseReport([]byte(tc.out), projids)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want an error, got %+v other=%d", proj, other)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(proj, tc.wantProj) {
				t.Errorf("projects = %+v\nwant       %+v", proj, tc.wantProj)
			}
			if other != tc.wantOther {
				t.Errorf("other = %d, want %d", other, tc.wantOther)
			}
		})
	}
}

func TestParseProjid(t *testing.T) {
	got := ParseProjid([]byte("# comment\n\n" + keyA + ":1041\n" + keyB + " : 1042\nbroken\n:5\nx:notanumber\nneg:-1\n"))
	want := map[string]uint64{keyA: 1041, keyB: 1042}
	// "name : id" has a space before the colon, so its name is not the bot key.
	delete(want, keyB)
	want[keyB+" "] = 1042
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v want %v", got, want)
	}
}

func fixedNow() time.Time { return time.Date(2026, 10, 6, 14, 8, 0, 0, time.UTC) }

func fakeFs(fs Fs, err error) StatfsFunc {
	return func(string) (Fs, error) { return fs, err }
}

func TestPartitionPercent(t *testing.T) {
	// The fixture of the contract: 500 GiB, 295547944960 used.
	fs := Fs{BlockSize: 4096, Blocks: 536870912000 / 4096, Free: 241322967040 / 4096, FreeRoot: 241322967040 / 4096}
	p := partition("/srv/myrmidon-xfs", fs)
	want := Partition{Mount: "/srv/myrmidon-xfs", TotalBytes: 536870912000, UsedBytes: 295547944960, FreeBytes: 241322967040, UsedPercent: 55.1}
	if p != want {
		t.Errorf("got %+v want %+v", p, want)
	}
	// Reserved blocks: free for a user is less than free in all.
	p = partition("/m", Fs{BlockSize: 1024, Blocks: 1000, Free: 90, FreeRoot: 100})
	if p.TotalBytes != 1024000 || p.UsedBytes != 900*1024 || p.FreeBytes != 90*1024 || p.UsedPercent != 90 {
		t.Errorf("reserved: %+v", p)
	}
	// An empty or full partition.
	if p := partition("/m", Fs{BlockSize: 4096}); p.UsedPercent != 0 || p.TotalBytes != 0 {
		t.Errorf("empty: %+v", p)
	}
	if p := partition("/m", Fs{BlockSize: 4096, Blocks: 10}); p.UsedPercent != 100 {
		t.Errorf("full: %+v", p)
	}
}

func TestCollectWithQuota(t *testing.T) {
	var gotName string
	var gotArgs []string
	deps := Deps{
		Statfs: fakeFs(Fs{BlockSize: 4096, Blocks: 1000, Free: 450, FreeRoot: 450}, nil),
		Run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			gotName, gotArgs = name, args
			return []byte("#0   100   0   0  00 [--------]\n" + keyA + "  6144  5120  6144  00 [--------]\n"), nil
		},
		ReadFile: func(p string) ([]byte, error) {
			if p != ProjidPath {
				t.Errorf("read %s", p)
			}
			return []byte(keyA + ":1041\n"), nil
		},
		Now: fixedNow,
	}
	r, err := Collect(context.Background(), "/srv/myrmidon-xfs", deps)
	if err != nil {
		t.Fatal(err)
	}
	if gotName != XfsQuotaBin || !reflect.DeepEqual(gotArgs, []string{"-x", "-c", "report -p -b -N", "/srv/myrmidon-xfs"}) {
		t.Errorf("command: %s %q", gotName, gotArgs)
	}
	if !r.QuotaEnabled || r.At != "2026-10-06T14:08:00Z" || r.Partition.UsedPercent != 55 {
		t.Errorf("%+v", r)
	}
	if len(r.Projects) != 1 || r.Projects[0].UsedBytes != 6144*1024 || r.Projects[0].ProjectID != 1041 {
		t.Errorf("projects %+v", r.Projects)
	}
	if r.Other.UsedBytes != 100*1024 {
		t.Errorf("other %+v", r.Other)
	}
	// The JSON carries exactly the keys of the contract.
	b, _ := json.Marshal(r)
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"partition", "projects", "other", "quotaEnabled", "at"} {
		if _, ok := m[k]; !ok {
			t.Errorf("no key %s in %s", k, b)
		}
	}
	if len(m) != 5 {
		t.Errorf("extra keys: %s", b)
	}
	var pr map[string]json.RawMessage
	var arr []map[string]json.RawMessage
	_ = json.Unmarshal(m["projects"], &arr)
	pr = arr[0]
	for _, k := range []string{"botKey", "projectId", "usedBytes", "softBytes", "hardBytes"} {
		if _, ok := pr[k]; !ok {
			t.Errorf("no project key %s", k)
		}
	}
	if len(pr) != 5 {
		t.Errorf("extra project keys: %s", m["projects"])
	}
}

func TestCollectQuotaOff(t *testing.T) {
	deps := Deps{
		Statfs: fakeFs(Fs{BlockSize: 4096, Blocks: 1000, Free: 500, FreeRoot: 500}, nil),
		Run: func(context.Context, string, ...string) ([]byte, error) {
			return []byte("partial"), errors.New("exit status 1")
		},
		ReadFile: func(string) ([]byte, error) { t.Error("projid read although quota is off"); return nil, nil },
		Now:      fixedNow,
	}
	r, err := Collect(context.Background(), "/srv", deps)
	if err != nil {
		t.Fatal(err)
	}
	if r.QuotaEnabled || r.Projects == nil || len(r.Projects) != 0 || r.Other.UsedBytes != 0 || r.Partition.UsedPercent != 50 {
		t.Errorf("%+v", r)
	}
	b, _ := json.Marshal(r)
	if !strings.Contains(string(b), `"projects":[]`) || !strings.Contains(string(b), `"quotaEnabled":false`) {
		t.Errorf("json: %s", b)
	}
}

func TestCollectErrors(t *testing.T) {
	base := Deps{Now: fixedNow, Statfs: fakeFs(Fs{BlockSize: 4096, Blocks: 10, Free: 5, FreeRoot: 5}, nil)}

	d := base
	d.Statfs = fakeFs(Fs{}, errors.New("no such file"))
	if _, err := Collect(context.Background(), "/x", d); !errors.Is(err, ErrStatfs) {
		t.Errorf("statfs: %v", err)
	}

	d = base
	d.Run = func(context.Context, string, ...string) ([]byte, error) { return []byte("garbage line\n"), nil }
	d.ReadFile = func(string) ([]byte, error) { return nil, nil }
	if _, err := Collect(context.Background(), "/x", d); !errors.Is(err, ErrReport) {
		t.Errorf("report: %v", err)
	}

	// A context that has ended is an error, not "quota is off".
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	d = base
	d.Run = func(c context.Context, _ string, _ ...string) ([]byte, error) { return nil, c.Err() }
	if _, err := Collect(ctx, "/x", d); !errors.Is(err, context.Canceled) {
		t.Errorf("ctx: %v", err)
	}
}

func TestCollectNoProjidFile(t *testing.T) {
	// Without the project table nothing can be named: all used space is "other".
	d := Deps{
		Statfs:   fakeFs(Fs{BlockSize: 4096, Blocks: 10, Free: 5, FreeRoot: 5}, nil),
		Run:      func(context.Context, string, ...string) ([]byte, error) { return []byte(keyA + " 4 0 0 00\n"), nil },
		ReadFile: func(string) ([]byte, error) { return nil, errors.New("absent") },
		Now:      fixedNow,
	}
	r, err := Collect(context.Background(), "/x", d)
	if err != nil || !r.QuotaEnabled || len(r.Projects) != 0 || r.Other.UsedBytes != 4096 {
		t.Errorf("%+v %v", r, err)
	}
}

// The contract fixture (C5, docs/myrmidon/bot-disk-contract/dockergate-disk.json)
// is what the board's schema accepts; the answer of this package must have the
// same keys and types: decoding it strictly and encoding it again gives the same
// document.
func TestResponseMatchesContractFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/myrmidon/bot-disk-contract/dockergate-disk.json")
	if os.IsNotExist(err) {
		t.Skip("contract fixture is outside this build context")
	}
	if err != nil {
		t.Fatal(err)
	}
	var r Response
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		t.Fatalf("the fixture has a key that Response does not: %v", err)
	}
	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	enc, _ := json.Marshal(r)
	if err := json.Unmarshal(enc, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Errorf("round trip differs:\n%s\n%s", raw, enc)
	}
	if r.Partition.UsedPercent != 55.1 || !r.QuotaEnabled {
		t.Errorf("%+v", r)
	}
}
