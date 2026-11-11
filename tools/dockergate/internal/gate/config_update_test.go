package gate_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// A20: dockergate runtime API config-update and platform ceilings validation.

func configUpdateBody(mem int64, cpus float64, pids int64) []byte {
	return []byte(fmt.Sprintf(`{"memoryMb":%d,"cpus":%g,"pidsLimit":%d}`, mem, cpus, pids))
}

func newA20Rig(t *testing.T, opts ...rigOpt) *rig {
	t.Helper()
	combined := append([]rigOpt{withConfig(func(c *config.Config) {
		c.VolumeRoot = "/srv/test-bots"
		if c.PlatformLimits == nil {
			c.PlatformLimits = &config.PlatformLimits{}
		}
	})}, opts...)
	return newRig(t, combined...)
}

func TestAllow_A20_UpdatePersistsAndReloadsWithoutContainerRestart(t *testing.T) {
	r := newA20Rig(t)
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
	r := newA20Rig(t)
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
	r := newA20Rig(t, withContainerCaller())
	r.seedMain("running")

	r.addSiblingProcess(102)
	r.setCred(102, 1000, 1000)

	body := configUpdateBody(512, 1.0, 200)
	res := r.send("PUT", "/myrmidon/bots/"+r.key()+"/limits", jsonHdr, body)
	wantDeny(t, res, deny.CallerNotBoardMain)
}

func TestAllow_A20_DockerPrefixRoute(t *testing.T) {
	r := newA20Rig(t)
	r.seedMain("running")

	body := configUpdateBody(512, 1.0, 200)
	res := r.send("PUT", "/v1.45/containers/myrmidon-bot-"+r.key()+"/config/update", jsonHdr, body)
	wantStatus(t, res, 200)
}

// A21 (OPE-12337): GET one enrolled bot's dockergate-side limits and ceilings.
func TestAllow_A21_GetBotLimits(t *testing.T) {
	r := newA20Rig(t)
	r.seedMain("running")

	for _, target := range []string{
		"/myrmidon/bots/" + r.key() + "/limits",
		"/myrmidon/config/bots/" + r.key(),
		"/v1.45/containers/myrmidon-bot-" + r.key() + "/config/limits",
		"/v1.45/containers/myrmidon-bot-" + r.key() + "/config/update",
	} {
		res := r.send("GET", target, nil, nil)
		wantStatus(t, res, 200)
		var resp struct {
			OK     bool    `json:"ok"`
			BotKey string  `json:"botKey"`
			Memory int64   `json:"memoryMb"`
			CPUs   float64 `json:"cpus"`
			Pids   int64   `json:"pidsLimit"`
		}
		if err := json.Unmarshal(res.Body, &resp); err != nil {
			t.Fatalf("%s: unmarshal: %v", target, err)
		}
		if !resp.OK || resp.BotKey != r.key() || resp.Memory != 2048 || resp.CPUs != 4 || resp.Pids != 2048 {
			t.Errorf("%s: unexpected limits: %+v", target, resp)
		}
	}

	// Ceiling and effective fields are present even when unset (zero values).
	var resp struct {
		CeilingMemory   int64   `json:"ceilingMemoryMb"`
		CeilingCPUs     float64 `json:"ceilingCpus"`
		CeilingPids     int64   `json:"ceilingPids"`
		EffectiveMemory int64   `json:"effectiveMemoryMb"`
		EffectiveCPUs   float64 `json:"effectiveCpus"`
		EffectivePids   int64   `json:"effectivePidsLimit"`
	}
	res := r.send("GET", "/myrmidon/bots/"+r.key()+"/limits", nil, nil)
	if err := json.Unmarshal(res.Body, &resp); err != nil {
		t.Fatalf("unmarshal ceilings: %v", err)
	}
	if resp.CeilingMemory < 0 || resp.CeilingCPUs < 0 || resp.CeilingPids < 0 {
		t.Errorf("negative ceilings: %+v", resp)
	}
	if resp.EffectiveMemory < 0 || resp.EffectiveCPUs < 0 || resp.EffectivePids < 0 {
		t.Errorf("negative effective limits: %+v", resp)
	}
}

// A21 (OPE-12337): PlatformLimits lower than bot limits cap the effective limits.
func TestAllow_A21_CeilingsBelowBotLimits(t *testing.T) {
	r := newA20Rig(t, withConfig(func(c *config.Config) {
		c.VolumeRoot = "/srv/test-bots"
		c.PlatformLimits = &config.PlatformLimits{
			MaxMemoryMB: 1024,
			MaxCPUs:     2.0,
			MaxPids:     500,
		}
	}))
	r.seedMain("running")

	res := r.send("GET", "/myrmidon/bots/"+r.key()+"/limits", nil, nil)
	wantStatus(t, res, 200)

	var resp struct {
		OK              bool    `json:"ok"`
		BotKey          string  `json:"botKey"`
		Memory          int64   `json:"memoryMb"`
		CPUs            float64 `json:"cpus"`
		Pids            int64   `json:"pidsLimit"`
		CeilingMemory   int64   `json:"ceilingMemoryMb"`
		CeilingCPUs     float64 `json:"ceilingCpus"`
		CeilingPids     int64   `json:"ceilingPids"`
		EffectiveMemory int64   `json:"effectiveMemoryMb"`
		EffectiveCPUs   float64 `json:"effectiveCpus"`
		EffectivePids   int64   `json:"effectivePidsLimit"`
	}
	if err := json.Unmarshal(res.Body, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.OK || resp.BotKey != r.key() {
		t.Fatalf("unexpected bot: %+v", resp)
	}
	// Enrolled bot-level limits remain unchanged
	if resp.Memory != 2048 || resp.CPUs != 4 || resp.Pids != 2048 {
		t.Errorf("expected bot limits (2048, 4, 2048), got (%d, %g, %d)", resp.Memory, resp.CPUs, resp.Pids)
	}
	// Ceilings match platformLimits
	if resp.CeilingMemory != 1024 || resp.CeilingCPUs != 2.0 || resp.CeilingPids != 500 {
		t.Errorf("expected ceilings (1024, 2.0, 500), got (%d, %g, %d)", resp.CeilingMemory, resp.CeilingCPUs, resp.CeilingPids)
	}
	// Effective limits are min(bot, ceiling)
	if resp.EffectiveMemory != 1024 || resp.EffectiveCPUs != 2.0 || resp.EffectivePids != 500 {
		t.Errorf("expected effective limits (1024, 2.0, 500), got (%d, %g, %d)", resp.EffectiveMemory, resp.EffectiveCPUs, resp.EffectivePids)
	}
}

func TestDeny_A21_BotNotEnrolled(t *testing.T) {
	r := newA20Rig(t)
	r.seedMain("running")

	res := r.send("GET", "/myrmidon/bots/00000000-0000-0000-0000-000000000000/limits", nil, nil)
	wantDeny(t, res, deny.BotNotEnrolled)
}

func TestDeny_A21_MethodNotAllowed(t *testing.T) {
	r := newA20Rig(t)
	r.seedMain("running")

	res := r.send("POST", "/myrmidon/bots/"+r.key()+"/limits", jsonHdr, configUpdateBody(512, 1, 100))
	wantDeny(t, res, deny.RouteNotAllowed)
}
