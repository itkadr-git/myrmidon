package gate_test

import (
	"strconv"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// A18: the live update of memory, swap and pids. The rig enrols the bot with
// MaxMemoryMB 2048 and MaxPids 2048.

const (
	mib = int64(1) << 20
	gib = int64(1) << 30
)

func updateBody(memory, swap, pids int64) []byte {
	return []byte(`{"Memory":` + strconv.FormatInt(memory, 10) + `,"MemorySwap":` + strconv.FormatInt(swap, 10) + `,"PidsLimit":` + strconv.FormatInt(pids, 10) + `}`)
}

func TestAllow_A18_UpdateForwardsOnlyCheckedFields(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	id := r.id("")
	res := r.send("POST", r.target("", "/update"), jsonHdr, updateBody(1*gib, 2*gib, 512))
	wantStatus(t, res, 200)
	r.wantURIs("GET "+r.target("", "/json"), "POST /v1.45/containers/"+id+"/update")
	calls := r.calls()
	got := string(calls[len(calls)-1].Body)
	want := `{"Memory":1073741824,"MemorySwap":2147483648,"PidsLimit":512}`
	if got != want {
		t.Errorf("the daemon got %q, want %q", got, want)
	}
}

func TestAllow_A18_SpacedBodyIsRewritten(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	body := []byte("{ \"PidsLimit\" : 512,\n \"Memory\": 1073741824 , \"MemorySwap\": 1073741824 }")
	res := r.send("POST", r.target("", "/update"), jsonHdr, body)
	wantStatus(t, res, 200)
	calls := r.calls()
	got := string(calls[len(calls)-1].Body)
	want := `{"Memory":1073741824,"MemorySwap":1073741824,"PidsLimit":512}`
	if got != want {
		t.Errorf("the daemon got %q, want %q", got, want)
	}
}

func TestDeny_A18_UpdateBody(t *testing.T) {
	cases := []struct {
		name string
		body []byte
		code string
	}{
		{"unknown CpuShares", []byte(`{"Memory":1073741824,"MemorySwap":2147483648,"PidsLimit":512,"CpuShares":1024}`), deny.JSONUnknownKey},
		{"unknown RestartPolicy", []byte(`{"Memory":1073741824,"MemorySwap":2147483648,"PidsLimit":512,"RestartPolicy":{"Name":"always"}}`), deny.JSONUnknownKey},
		{"unknown by case", []byte(`{"memory":1073741824,"MemorySwap":2147483648,"PidsLimit":512}`), deny.JSONUnknownKey},
		{"duplicate key", []byte(`{"Memory":1073741824,"Memory":1,"MemorySwap":2147483648,"PidsLimit":512}`), ""},
		{"missing PidsLimit", []byte(`{"Memory":1073741824,"MemorySwap":2147483648}`), deny.JSONType},
		{"string number", []byte(`{"Memory":"1073741824","MemorySwap":2147483648,"PidsLimit":512}`), deny.JSONType},
		{"not an object", []byte(`[1,2,3]`), deny.JSONType},
		{"not json", []byte(`{`), ""},
		{"memory zero", updateBody(0, 0, 512), deny.JSONValue},
		{"memory negative", updateBody(-1, 2*gib, 512), deny.JSONValue},
		{"memory over cap", updateBody(2*gib+mib, 3*gib, 512), deny.JSONValue},
		{"swap below memory", updateBody(1*gib, 1*gib-mib, 512), deny.JSONValue},
		{"swap unlimited", updateBody(1*gib, -1, 512), deny.JSONValue},
		{"swap over twice memory", updateBody(1*gib, 2*gib+mib, 512), deny.JSONValue},
		{"swap huge", updateBody(1*gib, 1<<50, 512), deny.JSONValue},
		{"pids zero", updateBody(1*gib, 2*gib, 0), deny.JSONValue},
		{"pids unlimited", updateBody(1*gib, 2*gib, -1), deny.JSONValue},
		{"pids over cap", updateBody(1*gib, 2*gib, 2049), deny.JSONValue},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t)
			r.seedMain("running")
			res := r.send("POST", r.target("", "/update"), jsonHdr, c.body)
			if c.code == "" {
				if res.Status < 400 || res.Status >= 500 {
					t.Errorf("status %d, body %q", res.Status, res.str())
				}
			} else {
				wantDeny(t, res, c.code)
			}
			if r.count("POST", "/v1.45/containers/") != 0 {
				t.Errorf("the daemon was told to update: %v", r.uris())
			}
		})
	}
}

func TestAllow_A18_LimitsAtTheCap(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	res := r.send("POST", r.target("", "/update"), jsonHdr, updateBody(2*gib, 4*gib, 2048))
	wantStatus(t, res, 200)
}

func TestDeny_A18_ContentType(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")
	res := r.send("POST", r.target("", "/update"), map[string]string{"Content-Type": "text/plain"}, updateBody(1*gib, 2*gib, 512))
	wantDeny(t, res, deny.ContentType)
	if r.count("POST", "/v1.45/containers/") != 0 {
		t.Errorf("the daemon was told to update: %v", r.uris())
	}
}

func TestAllow_A18_MissingContainerIs404(t *testing.T) {
	r := newRig(t)
	res := r.send("POST", r.target("", "/update"), jsonHdr, updateBody(1*gib, 2*gib, 512))
	wantStatus(t, res, 404)
	if r.count("POST", "/v1.45/containers/") != 0 {
		t.Errorf("the daemon was told to update: %v", r.uris())
	}
}
