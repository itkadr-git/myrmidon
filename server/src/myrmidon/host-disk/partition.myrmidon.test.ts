import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  WS_BOT_DISK_SETTING_DEFAULTS,
  wsBotDiskSettingsSchema,
  wsDiskApiResponseSchema,
} from "@paperclipai/shared";
import {
  normalizeWsBotDiskPartitionSettings,
  partitionAlertLevel,
  partitionPressureLevel,
  patchWsBotDiskPartitionSettingsSchema,
  resolveWsBotDiskPartitionSettings,
  wsBotDiskPartitionSettingsSchema,
} from "@paperclipai/shared";
import { createHostDiskSweep } from "./sweep.js";
import type { HostDiskSweepDeps } from "./sweep.js";
import { createDockergateDiskClient, dockergateBaseUrl } from "./dockergate.js";
import {
  botPartitionThresholdRuntimeForTest,
  type BotPartitionNotifyInput,
} from "./partition.js";
import type { BotPartitionUsage } from "./dockergate.js";

/**
 * Acceptance tests of OPE-5371 (myrmidon 1.6.5 BOT-DISK-H10).
 *
 * Boundaries 84/85/89/90/94/95 %: the card level and the pressure level
 * change exactly at the configured threshold; without dockergate data the
 * behaviour is the previous one (no partition card, "not measured");
 * settings validate 85<90<95; a repeated alert is not duplicated.
 */

const DEFAULTS = {
  partitionThresholdPercent: 85,
  partitionRefuseOpenPercent: 90,
  partitionCriticalPercent: 95,
};

function usage(usedPercent: number): BotPartitionUsage {
  const totalBytes = 500 * 1024 * 1024 * 1024;
  const usedBytes = Math.floor((usedPercent / 100) * totalBytes);
  return {
    mount: "/srv/myrmidon-xfs",
    usedBytes,
    totalBytes,
    freeBytes: totalBytes - usedBytes,
    usedPercent,
    at: "2026-10-07T01:00:00Z",
  };
}

function runtime(overrides: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
  notifyOwner?: (input: BotPartitionNotifyInput) => Promise<void>;
} = {}) {
  return botPartitionThresholdRuntimeForTest({
    getBotDiskSettings: async () => overrides.stored,
    notifyOwner: overrides.notifyOwner,
    env: overrides.env ?? {},
    now: () => new Date("2026-10-07T01:00:00Z"),
  });
}

describe("wsBotDiskPartitionSettingsSchema validation (85<90<95)", () => {
  it("accepts the contract defaults", () => {
    expect(wsBotDiskPartitionSettingsSchema.safeParse(DEFAULTS).success).toBe(true);
    expect(WS_BOT_DISK_SETTING_DEFAULTS.partitionThresholdPercent).toBe(85);
    expect(WS_BOT_DISK_SETTING_DEFAULTS.partitionRefuseOpenPercent).toBe(90);
    expect(WS_BOT_DISK_SETTING_DEFAULTS.partitionCriticalPercent).toBe(95);
  });

  it("rejects an unordered triple", () => {
    expect(
      wsBotDiskPartitionSettingsSchema.safeParse({
        partitionThresholdPercent: 90,
        partitionRefuseOpenPercent: 85,
        partitionCriticalPercent: 95,
      }).success,
    ).toBe(false);
    expect(
      wsBotDiskPartitionSettingsSchema.safeParse({
        partitionThresholdPercent: 85,
        partitionRefuseOpenPercent: 90,
        partitionCriticalPercent: 90,
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range and non-integer values", () => {
    for (const value of [0, 49, 100, 85.5, "85"]) {
      expect(
        wsBotDiskPartitionSettingsSchema.safeParse({ ...DEFAULTS, partitionThresholdPercent: value })
          .success,
      ).toBe(false);
    }
  });

  it("a stored row with a broken ordering is ignored as a whole (defaults take over)", () => {
    const resolved = resolveWsBotDiskPartitionSettings({
      stored: {
        partitionThresholdPercent: 92,
        partitionRefuseOpenPercent: 90,
        partitionCriticalPercent: 95,
      },
      env: {},
    });
    expect(resolved.settings).toEqual(DEFAULTS);
    expect(resolved.sources.partitionThresholdPercent).toBe("default");
  });

  it("patch schema is strict: unknown keys are rejected", () => {
    expect(patchWsBotDiskPartitionSettingsSchema.safeParse({ partitionThresholdPercent: 86 }).success).toBe(true);
    expect(patchWsBotDiskPartitionSettingsSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it("normalize ignores the other contract keys of general.botDisk (passthrough schema)", () => {
    const stored = {
      ...DEFAULTS,
      closingMinutes: 30, // another BOT-DISK-H part's key
    };
    expect(wsBotDiskSettingsSchema.safeParse(stored).success).toBe(true);
    expect(normalizeWsBotDiskPartitionSettings(stored)).toEqual(DEFAULTS);
  });

  it("env provides first-start defaults; a stored row wins", () => {
    const env = {
      MYRMIDON_BOT_PARTITION_THRESHOLD_PERCENT: "80",
      MYRMIDON_BOT_PARTITION_REFUSE_OPEN_PERCENT: "88",
      MYRMIDON_BOT_PARTITION_CRITICAL_PERCENT: "93",
    };
    const fromEnv = resolveWsBotDiskPartitionSettings({ env });
    expect(fromEnv.settings).toEqual({
      partitionThresholdPercent: 80,
      partitionRefuseOpenPercent: 88,
      partitionCriticalPercent: 93,
    });
    expect(fromEnv.sources.partitionCriticalPercent).toBe("env");
    const stored = resolveWsBotDiskPartitionSettings({ stored: DEFAULTS, env });
    expect(stored.settings).toEqual(DEFAULTS);
    expect(stored.sources.partitionThresholdPercent).toBe("settings");
  });
});

describe("threshold boundaries 84/85/89/90/94/95", () => {
  it.each([
    [84, "none", "none"],
    [85, "warn", "none"],
    [89, "warn", "none"],
    [90, "warn", "hard"],
    [94, "warn", "hard"],
    [95, "critical", "hard"],
    [100, "critical", "hard"],
  ] as const)("at %i%% the card is %s and the pressure is %s", (percent, alert, pressure) => {
    expect(partitionAlertLevel(percent, DEFAULTS)).toBe(alert);
    expect(partitionPressureLevel(percent, DEFAULTS)).toBe(pressure);
  });

  it("the runtime evaluates the card level at the exact boundary", async () => {
    const rt = runtime();
    expect((await rt.updateFromPartition(usage(84))).alertLevel).toBe("none");
    expect((await rt.updateFromPartition(usage(85))).alertLevel).toBe("warn");
    expect((await rt.updateFromPartition(usage(89))).alertLevel).toBe("warn");
    expect((await rt.updateFromPartition(usage(90))).pressureLevel).toBe("hard");
    expect((await rt.updateFromPartition(usage(94))).alertLevel).toBe("warn");
    expect((await rt.updateFromPartition(usage(95))).alertLevel).toBe("critical");
  });

  it("custom thresholds shift the boundary exactly", async () => {
    const rt = runtime({
      stored: {
        partitionThresholdPercent: 80,
        partitionRefuseOpenPercent: 88,
        partitionCriticalPercent: 93,
      },
    });
    expect((await rt.updateFromPartition(usage(79))).alertLevel).toBe("none");
    expect((await rt.updateFromPartition(usage(80))).alertLevel).toBe("warn");
    expect((await rt.updateFromPartition(usage(87))).pressureLevel).toBe("none");
    expect((await rt.updateFromPartition(usage(88))).pressureLevel).toBe("hard");
    expect((await rt.updateFromPartition(usage(92))).alertLevel).toBe("warn");
    expect((await rt.updateFromPartition(usage(93))).alertLevel).toBe("critical");
  });
});

describe("critical notification dedup", () => {
  it("notifies the owner exactly once per crossing of the critical threshold", async () => {
    const notifyOwner = vi.fn(async (_note: { level: string }) => undefined);
    const rt = runtime({ notifyOwner });
    await rt.updateFromPartition(usage(95));
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner.mock.calls[0][0].level).toBe("critical");
    await rt.updateFromPartition(usage(96));
    await rt.updateFromPartition(usage(97));
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("a warn crossing sends nothing; the latch re-arms after dropping below the warn threshold", async () => {
    const notifyOwner = vi.fn(async (_note: { level: string }) => undefined);
    const rt = runtime({ notifyOwner });
    await rt.updateFromPartition(usage(85));
    await rt.updateFromPartition(usage(90));
    expect(notifyOwner).not.toHaveBeenCalled();
    await rt.updateFromPartition(usage(95));
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    // Drop below the warn threshold: the latch resets; a new critical
    // crossing notifies again.
    await rt.updateFromPartition(usage(80));
    await rt.updateFromPartition(usage(95));
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });

  it("a failed notification does not latch (the next sweep retries)", async () => {
    const notifyOwner = vi.fn(async () => {
      throw new Error("telegram down");
    });
    const rt = runtime({ notifyOwner });
    const state = await rt.updateFromPartition(usage(95));
    expect(state.alertLevel).toBe("critical");
    expect(state.criticalNotified).toBe(false);
    await rt.updateFromPartition(usage(95));
    expect(notifyOwner).toHaveBeenCalledTimes(2);
  });
});

describe("no dockergate data: previous behaviour, marked not measured", () => {
  it("markUnmeasured resets the state: no card, pressure none", async () => {
    const notifyOwner = vi.fn(async (_note: { level: string }) => undefined);
    const rt = runtime({ notifyOwner });
    await rt.updateFromPartition(usage(97));
    expect(rt.current().alertLevel).toBe("critical");
    const cleared = rt.markUnmeasured();
    expect(cleared.partition).toBeNull();
    expect(cleared.alertLevel).toBeNull();
    expect(cleared.pressureLevel).toBe("none");
    expect(rt.current().alertLevel).toBeNull();
  });

  it("the sweep without a partition client behaves exactly as part E shipped it", async () => {
    const logActivity = vi.fn(async () => undefined);
    const deps: HostDiskSweepDeps = {
      dataRootPath: "/srv/data",
      consumerPaths: [],
      resolveSettings: async () => ({ usageThresholdPercent: 85 }),
      logActivity,
      lastSignalAt: async () => null,
      logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      measureUsage: async () => ({
        path: "/srv/data",
        usedBytes: 90,
        totalBytes: 100,
        freeBytes: 10,
        usedPercent: 90,
      }),
      // no partitionClient, no partitionRuntime — dockergate absent
    };
    const sweep = createHostDiskSweep(deps);
    const result = await sweep.sweep();
    expect(result.overThreshold).toBe(true);
    expect(result.signalled).toBe(true);
  });

  it("the sweep with a failing dockergate marks the partition unmeasured and still reports statfs", async () => {
    const rt = runtime();
    await rt.updateFromPartition(usage(96));
    const deps: HostDiskSweepDeps = {
      dataRootPath: "/srv/data",
      consumerPaths: [],
      resolveSettings: async () => ({ usageThresholdPercent: 99 }),
      logActivity: vi.fn(async () => undefined),
      lastSignalAt: async () => null,
      logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      measureUsage: async () => ({
        path: "/srv/data",
        usedBytes: 10,
        totalBytes: 100,
        freeBytes: 90,
        usedPercent: 10,
      }),
      partitionClient: { readPartitionUsage: async () => null },
      partitionRuntime: rt,
    };
    const sweep = createHostDiskSweep(deps);
    await sweep.sweep();
    expect(rt.current().alertLevel).toBeNull(); // not measured
    expect(rt.current().pressureLevel).toBe("none");
  });

  it("the sweep feeds the partition runtime from dockergate data", async () => {
    const rt = runtime();
    const deps: HostDiskSweepDeps = {
      dataRootPath: "/srv/data",
      consumerPaths: [],
      resolveSettings: async () => ({ usageThresholdPercent: 99 }),
      logActivity: vi.fn(async () => undefined),
      lastSignalAt: async () => null,
      logger: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      measureUsage: async () => ({
        path: "/srv/data",
        usedBytes: 10,
        totalBytes: 100,
        freeBytes: 90,
        usedPercent: 10,
      }),
      partitionClient: { readPartitionUsage: async () => usage(91) },
      partitionRuntime: rt,
    };
    const sweep = createHostDiskSweep(deps);
    await sweep.sweep();
    expect(rt.current().alertLevel).toBe("warn");
    expect(rt.current().pressureLevel).toBe("hard");
    expect(rt.current().partition?.usedPercent).toBe(91);
  });
});

describe("dockergate client (contract C5)", () => {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../../../docs/myrmidon/bot-disk-contract/dockergate-disk.json", import.meta.url),
      ),
      "utf8",
    ),
  );

  it("the contract fixture passes the schema and the client maps it", async () => {
    expect(wsDiskApiResponseSchema.safeParse(fixture).success).toBe(true);
    const client = createDockergateDiskClient({
      baseUrl: "http://dockergate:3399",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch,
    });
    const measured = await client.readPartitionUsage();
    expect(measured).not.toBeNull();
    expect(measured!.mount).toBe("/srv/myrmidon-xfs");
    expect(measured!.usedPercent).toBe(55.1);
  });

  it("returns null on a network error, a non-200, or a schema violation", async () => {
    const failing = createDockergateDiskClient({
      baseUrl: "http://dockergate:3399",
      fetchImpl: vi.fn(async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });
    expect(await failing.readPartitionUsage()).toBeNull();

    const notOk = createDockergateDiskClient({
      baseUrl: "http://dockergate:3399",
      fetchImpl: vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    expect(await notOk.readPartitionUsage()).toBeNull();

    const invalid = createDockergateDiskClient({
      baseUrl: "http://dockergate:3399",
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ partition: { mount: "/x" } }), { status: 200 }),
      ) as unknown as typeof fetch,
    });
    expect(await invalid.readPartitionUsage()).toBeNull();
  });

  it("without MYRMIDON_DOCKERGATE_URL the wiring stays disabled", () => {
    expect(dockergateBaseUrl({})).toBeNull();
    expect(dockergateBaseUrl({ MYRMIDON_DOCKERGATE_URL: " http://host:3399 " })).toBe("http://host:3399");
  });
});
