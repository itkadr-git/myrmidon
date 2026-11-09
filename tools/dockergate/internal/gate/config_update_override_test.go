package gate_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// OPE-12383: the A20 ceilings update when "limitsOverrideFile" is configured.
// The update goes to the override file in the writable state directory; the
// main config file (mounted read-only in production) is never written.

func newA20OverrideRig(t *testing.T, override string) *rig {
	t.Helper()
	return newA20Rig(t, withConfig(func(c *config.Config) {
		c.LimitsOverrideFile = override
	}))
}

func readOverride(t *testing.T, path string) []config.OverrideBot {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read override: %v", err)
	}
	bots, err := config.DecodeLimitsOverride(data)
	if err != nil {
		t.Fatalf("decode override: %v", err)
	}
	return bots
}

func TestAllow_A20Override_UpdateGoesToOverrideFile(t *testing.T) {
	override := filepath.Join(t.TempDir(), "limits-override.json")
	r := newA20OverrideRig(t, override)
	r.seedMain("running")

	// The rig's bot is enrolled with MaxMemoryMB 2048: 1536 stays within.
	body := configUpdateBody(1536, 2, 1024)
	res := r.send("PUT", "/myrmidon/bots/"+r.key()+"/limits", jsonHdr, body)
	wantStatus(t, res, 200)

	// The override file carries the update.
	bots := readOverride(t, override)
	if len(bots) != 1 || bots[0].BotKey != r.key() ||
		bots[0].MemoryMB != 1536 || bots[0].CPUs != 2 || bots[0].PidsLimit != 1024 {
		t.Fatalf("unexpected override entries: %+v", bots)
	}

	// The main config file still holds the enrolled limits: the read-only
	// file was never rewritten. (The rig writes its config to dir/config.json.)
	mainCfg := filepath.Join(r.dir, "config.json")
	cfg, _, err := config.Load(mainCfg)
	if err != nil {
		t.Fatalf("reload main: %v", err)
	}
	if cfg.Bots[0].MaxMemoryMB != 2048 {
		t.Fatalf("the main file was rewritten: %+v", cfg.Bots[0])
	}

	// The merged view of the main file now reports the overridden limit, with
	// the ceilings of the first update pinned (as the main-file path does).
	merged, _, err := config.LoadForRuntime(mainCfg)
	if err != nil {
		t.Fatalf("merged load: %v", err)
	}
	b, ok := merged.Bot(r.key())
	if !ok {
		t.Fatalf("the bot vanished from the merged view")
	}
	if b.MaxMemoryMB != 1536 || b.MaxCPUs != 2 || b.MaxPids != 1024 {
		t.Fatalf("the merged view does not carry the override: %+v", b)
	}
	if b.CeilingMemoryMB != 2048 || b.CeilingCPUs != 4 || b.CeilingPids != 2048 {
		t.Fatalf("the ceilings were not pinned: %+v", b)
	}
}

func TestAllow_A20Override_SecondUpdateReplacesTheEntry(t *testing.T) {
	override := filepath.Join(t.TempDir(), "limits-override.json")
	r := newA20OverrideRig(t, override)
	r.seedMain("running")

	res := r.send("PUT", "/myrmidon/bots/"+r.key()+"/limits", jsonHdr, configUpdateBody(1536, 2, 1024))
	wantStatus(t, res, 200)
	res = r.send("PUT", "/myrmidon/bots/"+r.key()+"/limits", jsonHdr, configUpdateBody(1792, 1, 512))
	wantStatus(t, res, 200)

	bots := readOverride(t, override)
	if len(bots) != 1 || bots[0].MemoryMB != 1792 || bots[0].CPUs != 1 || bots[0].PidsLimit != 512 {
		t.Fatalf("the entry was not replaced: %+v", bots)
	}
}

func TestDeny_A20Override_ReadOnlyStateDirReturnsConfigReadOnly(t *testing.T) {
	// The override directory does not exist: the write is refused by the
	// filesystem. OPE-12383: that is config_read_only with 403, never the old
	// upstream_error 502 that made the board's reconciler retry-loop.
	override := filepath.Join(t.TempDir(), "missing-dir", "limits-override.json")
	r := newA20OverrideRig(t, override)
	r.seedMain("running")

	res := r.send("PUT", "/myrmidon/bots/"+r.key()+"/limits", jsonHdr, configUpdateBody(1536, 2, 1024))
	wantDenyStatus(t, res, 403, deny.ConfigReadOnly)
	if len(r.calls()) != 0 {
		t.Errorf("the daemon was called: %v", r.uris())
	}
}

func TestDeny_A20Override_CorruptOverrideFileRefusesUpdate(t *testing.T) {
	override := filepath.Join(t.TempDir(), "limits-override.json")
	if err := os.WriteFile(override, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := newA20OverrideRig(t, override)
	r.seedMain("running")

	res := r.send("PUT", "/myrmidon/bots/"+r.key()+"/limits", jsonHdr, configUpdateBody(1536, 2, 1024))
	wantDeny(t, res, deny.ConfigReadOnly)
}
