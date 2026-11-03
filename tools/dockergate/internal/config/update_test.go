package config_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
)

const bot1Key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const bot2Key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

func validBaseConfig(t *testing.T) *config.Config {
	t.Helper()
	p := filepath.Join(t.TempDir(), "init.json")
	if err := os.WriteFile(p, []byte(goodJSON), 0600); err != nil {
		t.Fatalf("write goodJSON: %v", err)
	}
	cfg, _, err := config.Load(p)
	if err != nil {
		t.Fatalf("load goodJSON: %v", err)
	}
	cfg.Bots = []config.Bot{
		{BotKey: bot1Key, MaxMemoryMB: 512, MaxCPUs: 2, MaxPids: 100, CeilingMemoryMB: 2048, CeilingCPUs: 4, CeilingPids: 2048},
		{BotKey: bot2Key, MaxMemoryMB: 256, MaxCPUs: 1, MaxPids: 50},
	}
	return cfg
}

func TestApplyBotUpdatePreservesOtherBotsAndPersistsAtomically(t *testing.T) {
	cfg := validBaseConfig(t)
	if err := config.ApplyBotUpdate(cfg, config.BotUpdate{BotKey: bot1Key, MemoryMB: 384, CPUs: 1.5, PidsLimit: 80}); err != nil {
		t.Fatal(err)
	}
	if cfg.Bots[0].MaxMemoryMB != 384 || cfg.Bots[0].MaxCPUs != 1.5 || cfg.Bots[0].MaxPids != 80 {
		t.Fatalf("updated bot limits = %+v", cfg.Bots[0])
	}
	if cfg.Bots[1].MaxMemoryMB != 256 || cfg.Bots[1].MaxCPUs != 1 || cfg.Bots[1].MaxPids != 50 {
		t.Fatalf("other bot was modified: %+v", cfg.Bots[1])
	}

	path := filepath.Join(t.TempDir(), "dockergate.json")
	if err := config.WriteAtomic(path, cfg); err != nil {
		t.Fatal(err)
	}
	reloaded, _, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := reloaded.Bot(bot1Key); !ok || got.MaxMemoryMB != 384 || got.MaxCPUs != 1.5 || got.MaxPids != 80 {
		t.Fatalf("persisted update = %+v, found=%v", got, ok)
	}
	if _, err := os.Stat(filepath.Join(t.TempDir(), ".dockergate-config-unused")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected temp file stat result: %v", err)
	}
}

func TestApplyBotUpdateRejectsEachPlatformCeiling(t *testing.T) {
	cfg := validBaseConfig(t)
	cfg.PlatformLimits = &config.PlatformLimits{MaxMemoryMB: 512, MaxCPUs: 2, MaxPids: 100}

	cases := []struct {
		name string
		want config.BotUpdate
		part string
	}{
		{"memory", config.BotUpdate{BotKey: bot1Key, MemoryMB: 513, CPUs: 1, PidsLimit: 50}, "memoryMb 513 exceeds platform ceiling 512"},
		{"cpus", config.BotUpdate{BotKey: bot1Key, MemoryMB: 256, CPUs: 2.5, PidsLimit: 50}, "cpus 2.5 exceeds platform ceiling 2"},
		{"pids", config.BotUpdate{BotKey: bot1Key, MemoryMB: 256, CPUs: 1, PidsLimit: 101}, "pidsLimit 101 exceeds platform ceiling 100"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := config.ApplyBotUpdate(cfg.Clone(), tc.want)
			if err == nil || err.Error() != tc.part {
				t.Fatalf("error = %v; want %q", err, tc.part)
			}
		})
	}
}

func TestConfigClonePreservesCeilings(t *testing.T) {
	cfg := validBaseConfig(t)
	copy := cfg.Clone()
	if copy.PlatformLimits == nil || copy.PlatformLimits.MaxMemoryMB != 0 || copy.PlatformLimits.MaxCPUs != 0 || copy.PlatformLimits.MaxPids != 0 {
		t.Fatalf("platform limits not cloned: %+v", copy.PlatformLimits)
	}
	got, ok := copy.Bot(bot1Key)
	if !ok || got.CeilingMemoryMB != 2048 || got.CeilingCPUs != 4 || got.CeilingPids != 2048 {
		t.Fatalf("bot ceilings not cloned: %+v, found=%v", got, ok)
	}
}

func TestDecodeBotUpdateRejectsMissingAndMalformedBotKey(t *testing.T) {
	for _, body := range []string{
		`{"memoryMb":1,"cpus":1,"pidsLimit":1}`,
		`{"botKey":"bad","memoryMb":1,"cpus":1,"pidsLimit":1}`,
	} {
		if _, err := config.DecodeBotUpdate([]byte(body)); err == nil {
			t.Errorf("DecodeBotUpdate(%s) succeeded; want error", body)
		}
	}
}

func TestWriteAtomicRejectsEmptyPath(t *testing.T) {
	if err := config.WriteAtomic("", validBaseConfig(t)); err == nil {
		t.Fatal("WriteAtomic with empty path succeeded; want error")
	}
}
