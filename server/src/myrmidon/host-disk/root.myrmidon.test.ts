import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wsDiskApiResponseSchema } from "@myrmidon/shared";
import {
  normalizeWsRootDiskSettings,
  rootDiskAlertLevel,
  resolveWsRootDiskSettings,
  WS_ROOT_DISK_DEFAULTS,
  wsRootDiskSettingsSchema,
  patchWsRootDiskSettingsSchema,
} from "@myrmidon/shared";
import { createDockergateDiskClient } from "./dockergate.js";
import type { HostRootUsage } from "./dockergate.js";
import {
  HOST_ROOT_REPEAT_INTERVAL_MS,
  hostRootThresholdRuntimeForTest,
  type HostRootNotifyInput,
} from "./root.js";

/**
 * Acceptance tests of OPE-12697 (myrmidon 1.6.8 DISK-ALERT).
 *
 * The issue's test, verbatim: a service test with a stub A14 answer —
 * 80 % quiet, 86 % signal, 91 % alarm, a repeat within the hour is not
 * sent. The stub A14 answer is the wire `createDockergateDiskClient` reads;
 * the service under test is the root threshold runtime the sweep feeds.
 * The acceptance numbers land exactly: 85 % is quiet (>85 alerts), 90 %
 * is warn (>90 alarms), a level repeats at most once per hour.
 */

const GATE_FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../docs/myrmidon/bot-disk-contract/dockergate-disk.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

function rootUsage(usedPercent: number, at: string): HostRootUsage {
  const totalBytes = 286 * 1024 * 1024 * 1024;
  const usedBytes = Math.floor((usedPercent / 100) * totalBytes);
  return {
    mount: "/",
    usedBytes,
    totalBytes,
    freeBytes: totalBytes - usedBytes,
    usedPercent,
    at,
  };
}

/** A stub A14 answer: the gate fixture with the root percent replaced. */
function stubDiskAnswer(usedPercent: number, at: string): unknown {
  const totalBytes = 286 * 1024 * 1024 * 1024;
  const usedBytes = Math.floor((usedPercent / 100) * totalBytes);
  return {
    ...GATE_FIXTURE,
    root: {
      mount: "/",
      totalBytes,
      usedBytes,
      freeBytes: totalBytes - usedBytes,
      usedPercent,
    },
    at,
  };
}

function runtime(overrides: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
  notify?: (input: HostRootNotifyInput) => Promise<void>;
  now?: () => Date;
} = {}) {
  return hostRootThresholdRuntimeForTest({
    getBotDiskSettings: async () => overrides.stored,
    env: overrides.env ?? {},
    notify: overrides.notify,
    now: overrides.now,
  });
}

describe("resolveWsRootDiskSettings", () => {
  it("defaults 85/90 — the OPE-12697 acceptance numbers", () => {
    const resolved = resolveWsRootDiskSettings({ stored: undefined, env: {} });
    expect(resolved.settings).toEqual(WS_ROOT_DISK_DEFAULTS);
    expect(resolved.sources).toEqual({
      rootThresholdPercent: "default",
      rootCriticalPercent: "default",
    });
  });

  it("stored settings win over the environment", () => {
    const resolved = resolveWsRootDiskSettings({
      stored: { rootThresholdPercent: 80, rootCriticalPercent: 92 },
      env: { MYRMIDON_ROOT_DISK_THRESHOLD_PERCENT: "75" },
    });
    expect(resolved.settings).toEqual({ rootThresholdPercent: 80, rootCriticalPercent: 92 });
    expect(resolved.sources).toEqual({
      rootThresholdPercent: "settings",
      rootCriticalPercent: "settings",
    });
  });

  it("an invalid stored slice falls through key by key to env, then defaults", () => {
    const resolved = resolveWsRootDiskSettings({
      stored: { rootThresholdPercent: 95, rootCriticalPercent: 90 },
      env: { MYRMIDON_ROOT_DISK_CRITICAL_PERCENT: "93" },
    });
    expect(resolved.settings).toEqual({ rootThresholdPercent: 85, rootCriticalPercent: 93 });
    expect(resolved.sources.rootThresholdPercent).toBe("default");
    expect(resolved.sources.rootCriticalPercent).toBe("env");
  });

  it("rejects an inverted pair and out-of-range values", () => {
    expect(normalizeWsRootDiskSettings({ rootThresholdPercent: 90, rootCriticalPercent: 85 })).toBeNull();
    expect(wsRootDiskSettingsSchema.safeParse({ rootThresholdPercent: 10, rootCriticalPercent: 90 }).success).toBe(false);
    expect(patchWsRootDiskSettingsSchema.safeParse({ rootThresholdPercent: 85.5 }).success).toBe(false);
  });
});

describe("rootDiskAlertLevel", () => {
  it("80 quiet, 86 warn, 91 critical at the exact acceptance numbers", () => {
    const settings = WS_ROOT_DISK_DEFAULTS;
    expect(rootDiskAlertLevel(80, settings)).toBe("none");
    expect(rootDiskAlertLevel(85, settings)).toBe("none");
    expect(rootDiskAlertLevel(86, settings)).toBe("warn");
    expect(rootDiskAlertLevel(90, settings)).toBe("warn");
    expect(rootDiskAlertLevel(91, settings)).toBe("critical");
  });
});

describe("createDockergateDiskClient readRootUsage", () => {
  it("parses the root field of a stub A14 answer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(stubDiskAnswer(91.3, "2026-11-11T10:00:00Z")), { status: 200 }),
    );
    const client = createDockergateDiskClient({
      baseUrl: "http://dockergate.invalid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const usage = await client.readRootUsage();
    expect(usage).not.toBeNull();
    expect(usage!.mount).toBe("/");
    expect(usage!.usedPercent).toBeCloseTo(91.3, 5);
    // The wire answer the client parsed stays schema-valid.
    expect(wsDiskApiResponseSchema.safeParse(stubDiskAnswer(86, "2026-11-11T10:00:00Z")).success).toBe(true);
  });

  it("answers null when the gate predates the root field", async () => {
    const legacy = { ...GATE_FIXTURE };
    delete legacy.root;
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(legacy), { status: 200 }),
    );
    const client = createDockergateDiskClient({
      baseUrl: "http://dockergate.invalid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.readRootUsage()).toBeNull();
  });

  it("answers null when the gate is down", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("econnrefused"));
    const client = createDockergateDiskClient({
      baseUrl: "http://dockergate.invalid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.readRootUsage()).toBeNull();
  });
});

describe("root threshold runtime (the OPE-12697 service test)", () => {
  it("80% quiet, 86% one signal, 91% alarm, repeat within the hour not sent", async () => {
    let clock = Date.parse("2026-11-11T10:00:00Z");
    const sent: HostRootNotifyInput[] = [];
    const rt = runtime({
      notify: async (input) => {
        sent.push(input);
      },
      now: () => new Date(clock),
    });

    // 80 % — quiet.
    await rt.updateFromRoot(rootUsage(80, "2026-11-11T10:00:00Z"));
    expect(rt.current().alertLevel).toBe("none");
    expect(sent).toHaveLength(0);

    // +5 min: 86 % — the signal appears with the percent and the consumers.
    clock += 5 * 60_000;
    await rt.updateFromRoot(rootUsage(86, "2026-11-11T10:05:00Z"));
    expect(rt.current().alertLevel).toBe("warn");
    expect(sent).toHaveLength(1);
    expect(sent[0].level).toBe("warn");
    expect(sent[0].usage.usedPercent).toBeCloseTo(86, 5);
    expect(sent[0].settings.rootThresholdPercent).toBe(85);

    // +10 min: still 86 % — the level repeats at most once per hour: silent.
    clock += 10 * 60_000;
    await rt.updateFromRoot(rootUsage(86, "2026-11-11T10:15:00Z"));
    expect(sent).toHaveLength(1);

    // +10 min: 91 % — the level changed, the high alarm fires at once.
    clock += 10 * 60_000;
    await rt.updateFromRoot(rootUsage(91, "2026-11-11T10:25:00Z"));
    expect(rt.current().alertLevel).toBe("critical");
    expect(sent).toHaveLength(2);
    expect(sent[1].level).toBe("critical");

    // +10 min: still 91 % — silent again (once per hour per level).
    clock += 10 * 60_000;
    await rt.updateFromRoot(rootUsage(91, "2026-11-11T10:35:00Z"));
    expect(sent).toHaveLength(2);

    // +35 min: 92 % — 45 min past the critical signal, inside the hour: silent.
    clock += 35 * 60_000;
    await rt.updateFromRoot(rootUsage(92, "2026-11-11T11:10:00Z"));
    expect(sent).toHaveLength(2);

    // +20 min more: 65 min past the critical signal — the repeat fires.
    clock += 20 * 60_000;
    await rt.updateFromRoot(rootUsage(92, "2026-11-11T11:30:00Z"));
    expect(sent).toHaveLength(3);
    expect(sent[2].level).toBe("critical");
    expect(clock - Date.parse("2026-11-11T10:25:00Z")).toBeGreaterThanOrEqual(HOST_ROOT_REPEAT_INTERVAL_MS);
  });

  it("re-arms after usage drops below the warn threshold", async () => {
    let clock = Date.parse("2026-11-11T10:00:00Z");
    const sent: HostRootNotifyInput[] = [];
    const rt = runtime({
      notify: async (input) => {
        sent.push(input);
      },
      now: () => new Date(clock),
    });
    await rt.updateFromRoot(rootUsage(86, "2026-11-11T10:00:00Z"));
    expect(sent).toHaveLength(1);
    // Drop below the threshold: no signal, the latch clears on the next crossing.
    clock += 10 * 60_000;
    await rt.updateFromRoot(rootUsage(80, "2026-11-11T10:10:00Z"));
    expect(rt.current().alertLevel).toBe("none");
    expect(sent).toHaveLength(1);
    // A fresh crossing fires again even within the hour of the old signal.
    clock += 10 * 60_000;
    await rt.updateFromRoot(rootUsage(87, "2026-11-11T10:20:00Z"));
    expect(sent).toHaveLength(2);
  });

  it("a stale or inconsistent dockergate sample is not evidence", async () => {
    const sent: HostRootNotifyInput[] = [];
    // A fixed clock so the sample-age rule is deterministic (an hour-old
    // sample is beyond the 5-minute freshness window at any wall clock).
    const rt = runtime({
      notify: async (input) => void sent.push(input),
      now: () => new Date(Date.parse("2026-11-11T10:00:00Z")),
    });
    // A sample dated an hour ago — the sweep could have stalled; not evidence.
    await rt.updateFromRoot(rootUsage(96, "2026-11-11T09:00:00Z"));
    expect(rt.current().alertLevel).toBeNull();
    expect(sent).toHaveLength(0);
    // usedBytes above totalBytes — physically impossible, rejected.
    await rt.updateFromRoot({
      mount: "/",
      totalBytes: 100,
      usedBytes: 120,
      freeBytes: 0,
      usedPercent: 120,
      at: "2026-11-11T10:00:00Z",
    });
    expect(rt.current().root).toBeNull();
  });

  it("the sweep drains the runtime from the stub A14 client end to end", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(stubDiskAnswer(91, "2026-11-11T10:00:00Z")), { status: 200 }),
    );
    const client = createDockergateDiskClient({
      baseUrl: "http://dockergate.invalid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const sent: HostRootNotifyInput[] = [];
    const rt = runtime({
      notify: async (input) => void sent.push(input),
      now: () => new Date(Date.parse("2026-11-11T10:01:00Z")),
    });
    const usage = await client.readRootUsage();
    expect(usage).not.toBeNull();
    await rt.updateFromRoot(usage!);
    expect(rt.current().alertLevel).toBe("critical");
    expect(sent).toHaveLength(1);
    expect(sent[0].level).toBe("critical");
  });
});
