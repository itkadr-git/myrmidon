package config_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
)

// The limits-override file (OPE-12383): the mutable per-bot limits in a file
// the gate can write when the main config file is mounted read-only.

// fullConfig loads goodJSON (a config that passes Validate) and swaps the bot
// list for the two-bot set the override tests work on. ApplyLimitsOverride
// re-validates the merged result, so the tests must start from a config that
// is valid as a whole, not from a bare bot list.
func fullConfig(t *testing.T) (*config.Config, error) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "init.json")
	if err := os.WriteFile(p, []byte(goodJSON), 0o600); err != nil {
		t.Fatalf("write goodJSON: %v", err)
	}
	cfg, _, err := config.Load(p)
	if err != nil {
		t.Fatalf("load goodJSON: %v", err)
	}
	cfg.Bots = []config.Bot{
		{BotKey: bot1Key, MaxMemoryMB: 2048, MaxCPUs: 4, MaxPids: 2048, CeilingMemoryMB: 4096, CeilingCPUs: 4, CeilingPids: 2048},
		{BotKey: bot2Key, MaxMemoryMB: 256, MaxCPUs: 1, MaxPids: 50},
	}
	return cfg, nil
}

func TestDecodeLimitsOverride_AcceptsDocumentedShape(t *testing.T) {
	data := []byte(`{"bots":[{"botKey":"fb67e88b-0000-4000-8000-000000000001","memoryMb":3072,"cpus":2,"pidsLimit":1024}]}`)
	bots, err := config.DecodeLimitsOverride(data)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(bots) != 1 || bots[0].BotKey != "fb67e88b-0000-4000-8000-000000000001" ||
		bots[0].MemoryMB != 3072 || bots[0].CPUs != 2 || bots[0].PidsLimit != 1024 {
		t.Fatalf("unexpected bots: %+v", bots)
	}
}

func TestDecodeLimitsOverride_RefusesUnknownShape(t *testing.T) {
	cases := []struct {
		name string
		data []byte
	}{
		{"top-level array", []byte(`[{"botKey":"fb67e88b-0000-4000-8000-000000000001"}]`)},
		{"unknown key", []byte(`{"bots":[],"note":"hi"}`)},
		{"unknown bot field", []byte(`{"bots":[{"botKey":"fb67e88b-0000-4000-8000-000000000001","memoryMb":1,"cpus":1,"pidsLimit":1,"note":"x"}]}`)},
		{"duplicate botKey", []byte(`{"bots":[{"botKey":"fb67e88b-0000-4000-8000-000000000001","memoryMb":1,"cpus":1,"pidsLimit":1},{"botKey":"fb67e88b-0000-4000-8000-000000000001","memoryMb":2,"cpus":1,"pidsLimit":1}]}`)},
		{"bad uuid", []byte(`{"bots":[{"botKey":"not-a-uuid","memoryMb":1,"cpus":1,"pidsLimit":1}]}`)},
		{"trailing data", []byte(`{"bots":[]} {}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := config.DecodeLimitsOverride(tc.data); err == nil {
				t.Fatalf("decode of %s was accepted", tc.data)
			}
		})
	}
}

func TestLoadLimitsOverride_MissingFileIsNoOverride(t *testing.T) {
	bots, err := config.LoadLimitsOverride(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("missing file must not be an error: %v", err)
	}
	if bots != nil {
		t.Fatalf("unexpected bots: %+v", bots)
	}
}

func TestApplyLimitsOverride_ReplacesEnrolledLimitsOnly(t *testing.T) {
	// A full valid config: ApplyLimitsOverride re-validates the merged result,
	// so a bare bot list would refuse with an unrelated validation error.
	cfg, err := fullConfig(t)
	if err != nil {
		t.Fatal(err)
	}
	err = config.ApplyLimitsOverride(cfg, []config.OverrideBot{
		{BotKey: bot1Key, MemoryMB: 3072, CPUs: 2, PidsLimit: 1024, CeilingMemoryMB: 4096, CeilingCPUs: 4, CeilingPids: 2048},
	})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	first, ok := cfg.Bot(bot1Key)
	if !ok || first.MaxMemoryMB != 3072 || first.MaxCPUs != 2 || first.MaxPids != 1024 {
		t.Fatalf("limits were not applied: %+v", first)
	}
	if first.CeilingMemoryMB != 4096 {
		t.Fatalf("the ceiling moved: %+v", first)
	}
	second, ok := cfg.Bot(bot2Key)
	if !ok || second.MaxMemoryMB != 256 {
		t.Fatalf("an unrelated bot changed: %+v", second)
	}
}

func TestApplyLimitsOverride_RefusesUnenrolledBotAndKeepsConfig(t *testing.T) {
	cfg, err := fullConfig(t)
	if err != nil {
		t.Fatal(err)
	}
	err = config.ApplyLimitsOverride(cfg, []config.OverrideBot{
		{BotKey: "fb67e88b-0000-4000-8000-000000000009", MemoryMB: 1, CPUs: 1, PidsLimit: 1},
	})
	if err == nil {
		t.Fatal("an override for a bot that is not enrolled must be refused")
	}
	if first, _ := cfg.Bot(bot1Key); first.MaxMemoryMB != 2048 {
		t.Fatalf("a refused override changed the config: %+v", first)
	}
}

func TestLoadForRuntime_MergesOverride(t *testing.T) {
	dir := t.TempDir()
	main := filepath.Join(dir, "config.json")
	override := filepath.Join(dir, "state", "limits.json")
	// A missing override file at start (the override directory is created by
	// the first write) must not refuse the load. The main file is a full valid
	// config (goodJSON) with the override path and per-bot ceilings added:
	// LoadForRuntime re-validates the merged result, so a bots-only JSON would
	// refuse with an unrelated validation error.
	base := strings.Replace(goodJSON, `  "statsFile"`,
		`  "limitsOverrideFile": "`+override+`",
  "statsFile"`, 1)
	base = strings.Replace(base, `{"botKey": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "maxMemoryMb": 2048, "maxCpus": 2, "maxPids": 1024}`,
		`{"botKey": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "maxMemoryMb": 2048, "maxCpus": 2, "maxPids": 1024, "ceilingMemoryMb": 4096, "ceilingCpus": 4, "ceilingPids": 2048}`, 1)
	if err := os.WriteFile(main, []byte(base), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, hash, err := config.LoadForRuntime(main)
	if err != nil {
		t.Fatalf("load with an absent override file: %v", err)
	}
	if cfg.Bots[0].MaxMemoryMB != 2048 {
		t.Fatalf("an absent override changed the limits: %+v", cfg.Bots[0])
	}
	if hash == "" {
		t.Fatal("no hash for the main file")
	}

	// Now the override applies: 2048 -> 3072.
	bots, err := config.DecodeLimitsOverride([]byte(`{"bots":[{"botKey":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","memoryMb":3072,"cpus":2,"pidsLimit":1024}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := config.WriteLimitsOverride(override, bots); err != nil {
		t.Fatalf("write override: %v", err)
	}
	cfg, _, err = config.LoadForRuntime(main)
	if err != nil {
		t.Fatalf("load with override: %v", err)
	}
	if cfg.Bots[0].MaxMemoryMB != 3072 || cfg.Bots[0].MaxCPUs != 2 || cfg.Bots[0].MaxPids != 1024 {
		t.Fatalf("the override was not merged: %+v", cfg.Bots[0])
	}
	if cfg.LimitsOverrideFile != override {
		t.Fatalf("the override path moved: %q", cfg.LimitsOverrideFile)
	}

	// A corrupt override file refuses the load: the gate never runs on a
	// config it cannot verify.
	if err := os.WriteFile(override, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := config.LoadForRuntime(main); err == nil {
		t.Fatal("a corrupt override file must refuse the load")
	}
}

func TestWriteLimitsOverride_ReadOnlyDirectoryIsReadOnlyError(t *testing.T) {
	// The override directory does not exist (and cannot be created by a
	// rename): the write must be classified as read-only, not as a generic
	// failure (OPE-12383: config_read_only, not upstream_error).
	path := filepath.Join(t.TempDir(), "ro-state", "limits.json")
	bots := []config.OverrideBot{{BotKey: "fb67e88b-0000-4000-8000-000000000001", MemoryMB: 1, CPUs: 1, PidsLimit: 1}}
	err := config.WriteLimitsOverride(path, bots)
	if err == nil {
		t.Fatal("a write into a missing directory must fail")
	}
	var ro *config.ReadOnlyError
	if !strings.Contains(err.Error(), "limits override") || !asReadOnly(err, &ro) {
		t.Fatalf("the error is not classified as read-only: %v", err)
	}
}

func asReadOnly(err error, target **config.ReadOnlyError) bool {
	for err != nil {
		if ro, ok := err.(*config.ReadOnlyError); ok {
			*target = ro
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
