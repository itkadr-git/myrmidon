package gate_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// A20: dockergate runtime API config-update and platform ceilings validation.

func configUpdateBody(mem int64, cpus float64, pids int64) []byte {
	return []byte(fmt.Sprintf(`{"memoryMb":%d,"cpus":%g,"pidsLimit":%d}`, mem, cpus, pids))
}

func TestAllow_A20_UpdatePersistsAndReloadsWithoutContainerRestart(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")

	body := configUpdateBody(1024, 1.5, 500)
	res := r.send("PUT", "/myrmidon/bots/"+r.key()+"/limits", jsonHdr, body)
	wantStatus(t, res, 200)

	var resp struct {
		OK        bool    `json:"ok"`
		BotKey    string  `json:"botKey"`
		MemoryMB  int64   `json:"memoryMb"`
		CPUs      float64 `json:"cpus"`
		PidsLimit int64   `json:"pidsLimit"`
	}
	if err := json.Unmarshal(res.Body, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if !resp.OK || resp.BotKey != r.key() || resp.MemoryMB != 1024 || resp.CPUs != 1.5 || resp.PidsLimit != 500 {
		t.Errorf("unexpected response: %+v", resp)
	}

	// Ensure no container restarts or lifecycle calls reached the daemon
	for _, c := range r.calls() {
		if strings.Contains(c.URI, "/restart") || strings.Contains(c.URI, "/stop") {
			t.Errorf("daemon received container lifecycle call: %s %s", c.Method, c.URI)
		}
	}
}

func TestDeny_A20_ExceedsPlatformCeiling(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")

	// The enrolled bot in the rig has MaxMemoryMB 2048, MaxCPUs 4, MaxPids 2048.
	cases := []struct {
		name       string
		body       []byte
		wantDetail string
	}{
		{
			name:       "memory exceeds ceiling",
			body:       configUpdateBody(4096, 1.0, 500),
			wantDetail: "exceeds platform ceiling",
		},
		{
			name:       "cpus exceed ceiling",
			body:       configUpdateBody(1024, 8.0, 500),
			wantDetail: "exceeds platform ceiling",
		},
		{
			name:       "pids exceed ceiling",
			body:       configUpdateBody(1024, 1.0, 4096),
			wantDetail: "exceeds platform ceiling",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := r.send("PUT", "/myrmidon/bots/"+r.key()+"/limits", jsonHdr, tc.body)
			wantDeny(t, res, deny.LimitExceedsCeiling)
			if !strings.Contains(r.log.String(), tc.wantDetail) {
				t.Errorf("expected audit detail containing %q, log: %s", tc.wantDetail, r.log.String())
			}
		})
	}
}

func TestDeny_A20_CallerAuthentication(t *testing.T) {
	r := newRig(t, withContainerCaller())
	r.seedMain("running")

	r.addSiblingProcess(102)
	r.setCred(102, 1000, 1000)

	body := configUpdateBody(512, 1.0, 200)
	res := r.send("PUT", "/myrmidon/bots/"+r.key()+"/limits", jsonHdr, body)
	wantDeny(t, res, deny.CallerNotBoardMain)
}

func TestAllow_A20_DockerPrefixRoute(t *testing.T) {
	r := newRig(t)
	r.seedMain("running")

	body := configUpdateBody(512, 1.0, 200)
	res := r.send("PUT", "/v1.45/containers/myrmidon-bot-"+r.key()+"/config/update", jsonHdr, body)
	wantStatus(t, res, 200)
}
