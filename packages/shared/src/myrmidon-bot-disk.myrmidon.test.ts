// myrmidon(1.6.6 SETTINGS-UI-B / OPE-6258): the 14 stored keys of
// `general.botDisk` survive every PATCH. Before this part the five
// workspace-lifecycle numbers (closing grace, scratch TTL, the three partition
// percents) lived only under `wsBotDiskSettingsSchema` and were not part of the
// patch schema, so a patch of any layout key rewrote the object without them.

import { describe, expect, it } from "vitest";
import {
  BOT_DISK_SETTING_KEYS,
  BOT_DISK_LAYOUT_KEYS,
  BOT_DISK_WORKSPACE_LIFECYCLE_KEYS,
  botDiskSettingsSchema,
  mergeBotDiskSettings,
  patchBotDiskSettingsSchema,
  resolveBotDiskSettings,
} from "./myrmidon-bot-disk.js";

const BASE = {
  enabled: true,
  idleTtlMs: 3_600_000,
  graceClosingMinutes: 45,
  scratchTtlHours: 12,
  partitionThresholdPercent: 80,
  partitionRefuseOpenPercent: 88,
  partitionCriticalPercent: 97,
  sharedPackageCachePath: "/srv/myrmidon/cache",
  gitMirrorRepos: ["owner/repo"],
  gitMirrorRefreshMs: 900_000,
  pnpmStoreDir: "/data/hermes/.store",
  pnpmImportMethod: "copy" as const,
  sharedCacheRoles: ["engineer"],
  sharedBotRuntimePath: "/srv/myrmidon/runtime",
};

describe("1.6.6-SETTINGS-UI-B bot disk stored shape", () => {
  it("the three key groups are 14 distinct keys", () => {
    const all = [...BOT_DISK_SETTING_KEYS, ...BOT_DISK_LAYOUT_KEYS, ...BOT_DISK_WORKSPACE_LIFECYCLE_KEYS];
    expect(new Set(all).size).toBe(14);
  });

  it("the canonical schema accepts all 14 keys", () => {
    expect(botDiskSettingsSchema.safeParse(BASE).success).toBe(true);
  });

  it("the patch schema accepts the five workspace-lifecycle keys", () => {
    expect(patchBotDiskSettingsSchema.safeParse({ graceClosingMinutes: 30 }).success).toBe(true);
    expect(patchBotDiskSettingsSchema.safeParse({ partitionCriticalPercent: null }).success).toBe(true);
    // Out of range still fails: the same ranges wsBotDiskSettingsSchema uses.
    expect(patchBotDiskSettingsSchema.safeParse({ graceClosingMinutes: 1 }).success).toBe(false);
    expect(patchBotDiskSettingsSchema.safeParse({ partitionThresholdPercent: 40 }).success).toBe(false);
  });

  it("a patch of one layout key keeps every other stored key", () => {
    const merged = mergeBotDiskSettings(BASE as never, { pnpmStoreDir: "/scratch/.store" });
    expect(merged).toEqual({ ...BASE, pnpmStoreDir: "/scratch/.store" });
  });

  it("a patch of one workspace-lifecycle key keeps the other four", () => {
    const merged = mergeBotDiskSettings(BASE as never, { scratchTtlHours: 6 });
    expect(merged.scratchTtlHours).toBe(6);
    expect(merged.graceClosingMinutes).toBe(45);
    expect(merged.partitionThresholdPercent).toBe(80);
    expect(merged.partitionRefuseOpenPercent).toBe(88);
    expect(merged.partitionCriticalPercent).toBe(97);
  });

  it("null returns a workspace-lifecycle key to its default (the key goes away)", () => {
    const merged = mergeBotDiskSettings(BASE as never, { graceClosingMinutes: null, partitionCriticalPercent: null });
    expect("graceClosingMinutes" in merged).toBe(false);
    expect("partitionCriticalPercent" in merged).toBe(false);
    expect(merged.scratchTtlHours).toBe(12);
  });
});

describe("1.6.6-SETTINGS-UI-B resolve of the workspace-lifecycle keys", () => {
  it("stored values appear in settings and claim the \"settings\" source", () => {
    const stored = { ...BASE, enabled: false };
    const resolved = resolveBotDiskSettings({ stored });
    for (const key of BOT_DISK_WORKSPACE_LIFECYCLE_KEYS) {
      expect(resolved.settings[key]).toBe(stored[key as keyof typeof stored]);
    }
  });

  it("absent keys stay absent (no materialized defaults in the row)", () => {
    const resolved = resolveBotDiskSettings({ stored: { enabled: true, idleTtlMs: 1 } });
    for (const key of BOT_DISK_WORKSPACE_LIFECYCLE_KEYS) {
      expect(key in resolved.settings).toBe(false);
    }
    // sources keeps the env-backed pair only, like the layout keys.
    expect(Object.keys(resolved.sources).sort()).toEqual(["enabled", "idleTtlMs"]);
  });

  it("an invalid stored value is dropped instead of failing the block", () => {
    const resolved = resolveBotDiskSettings({ stored: { graceClosingMinutes: "soon", scratchTtlHours: 1.5 } });
    expect("graceClosingMinutes" in resolved.settings).toBe(false);
    expect("scratchTtlHours" in resolved.settings).toBe(false);
  });
});
