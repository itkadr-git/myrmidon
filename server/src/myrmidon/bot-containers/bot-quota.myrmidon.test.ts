// myrmidon(1.6.1-BOT-DISK-C): unit tests for the quota contract, the volume
// measurement, the sweep signal registry and the admission decision.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BOT_DISK_QUOTA_EXCEEDED_ERROR_CODE,
  BOT_DISK_QUOTA_SETTINGS_KEY,
  botDiskQuotaDedupKey,
  botDiskQuotaRejectionMessage,
  botDiskQuotaWhyNow,
  isBotApproachingQuota,
  isBotOverQuota,
  normalizeBotDiskQuotaSettings,
  resolveBotDiskQuotaMb,
  type BotDiskQuotaSettings,
} from "@paperclipai/shared";
import {
  BOT_VOLUME_ROOT_ENV,
  measureBotVolumeSize,
  readBotDiskQuotaSignals,
  recordBotDiskQuotaSignals,
  resetBotDiskQuotaSignalsForTests,
} from "./bot-quota.js";
import { createBotDiskQuotaSweep } from "./bot-disk-quota-sweep.js";

// --- shared contract: resolution and thresholds -----------------------------

describe("myrmidon(BOT-DISK-C) quota resolution", () => {
  const settings: BotDiskQuotaSettings = {
    defaultQuotaMb: 1000,
    perCaste: [{ casteKey: "engineer", quotaMb: 5000 }],
    perAgent: [{ agentKey: "a0000000-0000-4000-8000-000000000001", quotaMb: 250 }],
  };

  it("per-agent wins over per-caste and the default", () => {
    expect(resolveBotDiskQuotaMb(settings, "a0000000-0000-4000-8000-000000000001", "engineer")).toBe(250);
  });

  it("per-caste wins over the default", () => {
    expect(resolveBotDiskQuotaMb(settings, "a0000000-0000-4000-8000-000000000002", "engineer")).toBe(5000);
  });

  it("falls back to the default", () => {
    expect(resolveBotDiskQuotaMb(settings, "a0000000-0000-4000-8000-000000000003", "reviewer")).toBe(1000);
  });

  it("no default means no quota", () => {
    const off = { ...settings, defaultQuotaMb: null as number | null, perCaste: [], perAgent: [] };
    expect(resolveBotDiskQuotaMb(off, "a0000000-0000-4000-8000-000000000003", null)).toBeNull();
  });

  it("a corrupt stored object reads as the no-quota default", () => {
    expect(normalizeBotDiskQuotaSettings({ defaultQuotaMb: -5 })).toEqual({
      defaultQuotaMb: null,
      perCaste: [],
      perAgent: [],
    });
    expect(normalizeBotDiskQuotaSettings("nonsense")).toEqual({
      defaultQuotaMb: null,
      perCaste: [],
      perAgent: [],
    });
  });

  it("the settings key is its own general key (not a sub-key of part A)", () => {
    expect(BOT_DISK_QUOTA_SETTINGS_KEY).toBe("botDiskQuota");
  });
});

describe("myrmidon(BOT-DISK-C) thresholds", () => {
  const MB = 1024 * 1024;
  it("80% approaching, strictly-over exceeded", () => {
    expect(isBotApproachingQuota(799 * MB, 1000)).toBe(false);
    expect(isBotApproachingQuota(800 * MB, 1000)).toBe(true);
    expect(isBotOverQuota(1000 * MB, 1000)).toBe(false); // at the quota is not over it
    expect(isBotOverQuota(1001 * MB, 1000)).toBe(true);
  });
  it("no quota never trips", () => {
    expect(isBotApproachingQuota(10 * 1024 * MB, null)).toBe(false);
    expect(isBotOverQuota(10 * 1024 * MB, null)).toBe(false);
  });
  it("the rejection message carries the stable code first", () => {
    const message = botDiskQuotaRejectionMessage({ agentName: "Eng One", usageBytes: 1500 * MB, quotaMb: 1000 });
    expect(message.startsWith(BOT_DISK_QUOTA_EXCEEDED_ERROR_CODE)).toBe(true);
    expect(message).toContain("Eng One");
    expect(message).toContain("1500 MB");
  });
  it("the signal copy distinguishes over from approaching", () => {
    expect(botDiskQuotaWhyNow({ overQuota: true, usageBytes: 1500 * MB, quotaMb: 1000 })).toContain("quota exceeded");
    expect(botDiskQuotaWhyNow({ overQuota: false, usageBytes: 900 * MB, quotaMb: 1000 })).toContain("almost full");
  });
  it("the dedup key is stable per agent", () => {
    expect(botDiskQuotaDedupKey("agent-1")).toBe(botDiskQuotaDedupKey("agent-1"));
    expect(botDiskQuotaDedupKey("agent-1")).not.toBe(botDiskQuotaDedupKey("agent-2"));
  });
});

// --- volume measurement ------------------------------------------------------

describe("myrmidon(BOT-DISK-C) measureBotVolumeSize", () => {
  let root = "";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-quota-measure-"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("a missing directory measures 0", async () => {
    expect(await measureBotVolumeSize(path.join(root, "never-created"))).toEqual({
      sizeBytes: 0,
      truncated: false,
    });
  });

  it("counts regular files, measures but never follows symlinks", async () => {
    const dir = path.join(root, "links");
    await fs.mkdir(path.join(dir, "keep"), { recursive: true });
    await fs.writeFile(path.join(dir, "keep", "a.txt"), "x".repeat(100));
    // a symlink to a big file outside the tree: its own size counts, the target's not
    await fs.writeFile(path.join(root, "outside.bin"), "y".repeat(4096));
    await fs.symlink(path.join(root, "outside.bin"), path.join(dir, "link.bin"));

    const { sizeBytes, truncated } = await measureBotVolumeSize(dir);
    expect(truncated).toBe(false);
    expect(sizeBytes).toBeGreaterThanOrEqual(100);
    expect(sizeBytes).toBeLessThan(4096); // the target was not walked
  });

  it("counts a hardlinked file once within one bot", async () => {
    const dir = path.join(root, "hardlinks");
    await fs.mkdir(dir, { recursive: true });
    const original = path.join(dir, "store.txt");
    await fs.writeFile(original, "z".repeat(2048));
    await fs.link(original, path.join(dir, "copy.txt"));

    const { sizeBytes } = await measureBotVolumeSize(dir);
    expect(sizeBytes).toBe(2048);
  });

  it("stops at the entry cap and reports a lower bound", async () => {
    const dir = path.join(root, "many");
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 60 }, (_, i) => fs.writeFile(path.join(dir, `f${i}.txt`), "x")),
    );
    const { truncated } = await measureBotVolumeSize(dir);
    // 60 files are far below the cap: not truncated
    expect(truncated).toBe(false);
  });
});

// --- signal registry ---------------------------------------------------------

describe("myrmidon(BOT-DISK-C) signal registry", () => {
  afterEach(() => resetBotDiskQuotaSignalsForTests());

  it("records, reads and clears per company", () => {
    const signal = {
      agentId: "agent-1",
      dedupKey: botDiskQuotaDedupKey("agent-1"),
      overQuota: true,
      usageBytes: 2 * 1024 * 1024 * 1024,
      quotaMb: 1000,
      observedAtMs: 1,
    };
    recordBotDiskQuotaSignals("company-1", [signal]);
    expect(readBotDiskQuotaSignals("company-1")).toEqual([signal]);
    expect(readBotDiskQuotaSignals("company-2")).toEqual([]);
    recordBotDiskQuotaSignals("company-1", []);
    expect(readBotDiskQuotaSignals("company-1")).toEqual([]);
  });
});

// --- sweep with a fake db ----------------------------------------------------

interface FakeAgentRow {
  id: string;
  companyId: string;
  name: string;
  role: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  updatedAt: Date;
}

/**
 * A minimal thenable query builder: both db queries the sweep runs (the paged
 * rotation select and the alive-ids prune) resolve to the same row list, which
 * is the correct answer for a single-company fake.
 */
function fakeDb(rows: FakeAgentRow[]) {
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return (resolve: (value: FakeAgentRow[]) => unknown) => resolve(rows);
        return () => chain;
      },
    },
  );
  return { select: () => chain } as never;
}

describe("myrmidon(BOT-DISK-C) sweep", () => {
  let root = "";
  const agentId = randomUUID();
  const companyId = randomUUID();
  const MB = 1024 * 1024;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-quota-sweep-"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    resetBotDiskQuotaSignalsForTests();
  });
  afterEach(() => resetBotDiskQuotaSignalsForTests());

  const rows: FakeAgentRow[] = [
    {
      id: agentId,
      companyId,
      name: "Sweep Bot",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      updatedAt: new Date(0),
    },
  ];

  it("no volume root env: inert, clears signals, measures nothing", async () => {
    const sweep = createBotDiskQuotaSweep({
      db: fakeDb(rows),
      resolveSettings: async () => ({ defaultQuotaMb: 1, perCaste: [], perAgent: [] }),
      env: {},
    });
    const result = await sweep.sweep();
    expect(result.measured).toBe(0);
    expect(readBotDiskQuotaSignals(companyId)).toEqual([]);
  });

  it("a bot over quota gets a signal; back under the threshold clears it", async () => {
    const volumeDir = path.join(root, agentId);
    await fs.mkdir(volumeDir, { recursive: true });
    // 3 MB of data against a 2 MB quota: over.
    await fs.writeFile(path.join(volumeDir, "fill.bin"), Buffer.alloc(3 * MB));

    const sweep = createBotDiskQuotaSweep({
      db: fakeDb(rows),
      resolveSettings: async () => ({ defaultQuotaMb: 2, perCaste: [], perAgent: [] }),
      env: { [BOT_VOLUME_ROOT_ENV]: root },
      remeasureIntervalMs: 0, // measure on every tick of this test
    });

    const result = await sweep.sweep();
    expect(result.measured).toBe(1);
    const signals = readBotDiskQuotaSignals(companyId);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ agentId, overQuota: true, quotaMb: 2 });

    // shrink under the approaching threshold (2 MB * 0.8 = 1.6 MB): the signal must go away
    await fs.rm(path.join(volumeDir, "fill.bin"));
    await fs.writeFile(path.join(volumeDir, "small.bin"), Buffer.alloc(MB));
    await sweep.sweep();
    expect(readBotDiskQuotaSignals(companyId)).toEqual([]);
  });

  it("a bot without a quota is skipped and never signals", async () => {
    const sweep = createBotDiskQuotaSweep({
      db: fakeDb(rows),
      resolveSettings: async () => ({ defaultQuotaMb: null, perCaste: [], perAgent: [] }),
      env: { [BOT_VOLUME_ROOT_ENV]: root },
    });
    const result = await sweep.sweep();
    expect(result.scanned).toBe(1);
    expect(result.skippedNoQuota).toBe(1);
    expect(result.measured).toBe(0);
    expect(readBotDiskQuotaSignals(companyId)).toEqual([]);
  });
});

// --- BOT-DISK-H9c: quota enforcement and physical usage through dockergate ----

describe("myrmidon(BOT-DISK-H9c) sweep with dockergate", () => {
  const GIB = 1024 * 1024 * 1024;
  const MBYTES = 1024 * 1024;
  const agentId = randomUUID();
  const companyId = randomUUID();
  let root = "";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-quota-h9c-"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    resetBotDiskQuotaSignalsForTests();
  });
  afterEach(() => resetBotDiskQuotaSignalsForTests());

  const row = (adapterConfig: Record<string, unknown> = {}): FakeAgentRow => ({
    id: agentId,
    companyId,
    name: "Gate Bot",
    role: "engineer",
    adapterType: "hermes_gateway",
    adapterConfig,
    updatedAt: new Date(0),
  });
  const card = (diskQuotaMb: number) => ({
    container: { enabled: true, image: "bot:1", memoryMb: 512, cpus: 1, pidsLimit: 100, diskQuotaMb },
  });

  function disk(over: { quotaEnabled?: boolean; usedBytes?: number; hardBytes?: number; project?: boolean } = {}) {
    return {
      partition: { mount: "/srv/x", totalBytes: 100 * GIB, usedBytes: 10 * GIB, freeBytes: 90 * GIB, usedPercent: 10 },
      projects:
        over.project === false
          ? []
          : [{ botKey: agentId, projectId: 7, usedBytes: over.usedBytes ?? 0, softBytes: 0, hardBytes: over.hardBytes ?? 1000 * MBYTES }],
      other: { usedBytes: 0 },
      quotaEnabled: over.quotaEnabled ?? true,
      at: "2026-10-06T14:08:00Z",
    };
  }

  function fakeGate(state: { disk: unknown | Error }) {
    const puts: { botKey: string; bytes: number }[] = [];
    let gets = 0;
    return {
      puts,
      gets: () => gets,
      gate: {
        getDisk: async () => {
          gets += 1;
          if (state.disk instanceof Error) throw state.disk;
          return state.disk as never;
        },
        putQuota: async (botKey: string, bytes: number) => {
          puts.push({ botKey, bytes });
          return { ok: true as const, projectId: 7, hardBytes: bytes };
        },
      },
    };
  }

  const settings = (mb: number | null) => async () => ({ defaultQuotaMb: mb, perCaste: [], perAgent: [] });

  it("a card quota change puts once; unchanged quota puts nothing", async () => {
    const state = { disk: disk({ hardBytes: 1000 * MBYTES }) as unknown };
    const { gate, puts } = fakeGate(state);
    const rows = [row(card(2000))];
    const make = () =>
      createBotDiskQuotaSweep({ db: fakeDb(rows), resolveSettings: settings(null), env: {}, gate, remeasureIntervalMs: 0 });
    const sweep = make();
    // the card says 2000 MB, the partition holds 1000 MB: one PUT
    const first = await sweep.sweep();
    expect(first.quotaPut).toBe(1);
    expect(puts).toEqual([{ botKey: agentId, bytes: 2000 * MBYTES }]);
    // same quota again: zero PUTs, even though the (stale) disk answer still says 1000 MB
    await sweep.sweep();
    await sweep.sweep();
    expect(puts).toHaveLength(1);
    // the card changes: one more PUT
    // fakeDb holds this very array, so the card change is made in place
    rows[0] = row(card(3000));
    await sweep.sweep();
    expect(puts).toEqual([
      { botKey: agentId, bytes: 2000 * MBYTES },
      { botKey: agentId, bytes: 3000 * MBYTES },
    ]);
  });

  it("a quota already in force on the partition is not put at all", async () => {
    const { gate, puts } = fakeGate({ disk: disk({ hardBytes: 1000 * MBYTES }) });
    const sweep = createBotDiskQuotaSweep({
      db: fakeDb([row()]),
      resolveSettings: settings(1000),
      env: {},
      gate,
    });
    await sweep.sweep();
    expect(puts).toEqual([]);
  });

  it("quotaEnabled=false: no PUT, du estimate, signal marked as estimate", async () => {
    const volumeDir = path.join(root, agentId);
    await fs.mkdir(volumeDir, { recursive: true });
    await fs.writeFile(path.join(volumeDir, "fill.bin"), Buffer.alloc(3 * MBYTES));
    const { gate, puts } = fakeGate({ disk: disk({ quotaEnabled: false, project: false }) });
    const sweep = createBotDiskQuotaSweep({
      db: fakeDb([row()]),
      resolveSettings: settings(2),
      env: { [BOT_VOLUME_ROOT_ENV]: root },
      gate,
      remeasureIntervalMs: 0,
    });
    const result = await sweep.sweep();
    expect(puts).toEqual([]);
    expect(result.physicalAvailable).toBe(false);
    const signals = readBotDiskQuotaSignals(companyId);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ overQuota: true, usageBytes: 3 * MBYTES, usageSource: "estimate" });
    expect(botDiskQuotaWhyNow(signals[0]!)).toContain("estimate");
    await fs.rm(volumeDir, { recursive: true, force: true });
  });

  it("signals follow the physical numbers: 79 % none, 80 % approaching, over 100 % exceeded", async () => {
    // a big du-visible file proves the physical number is what counts
    const volumeDir = path.join(root, agentId);
    await fs.mkdir(volumeDir, { recursive: true });
    await fs.writeFile(path.join(volumeDir, "big.bin"), Buffer.alloc(3 * MBYTES));
    const state = { disk: disk({ usedBytes: 790 * MBYTES }) as unknown };
    const { gate } = fakeGate(state);
    const sweep = createBotDiskQuotaSweep({
      db: fakeDb([row()]),
      resolveSettings: settings(1000),
      env: { [BOT_VOLUME_ROOT_ENV]: root },
      gate,
    });
    await sweep.sweep();
    expect(readBotDiskQuotaSignals(companyId)).toEqual([]);

    state.disk = disk({ usedBytes: 800 * MBYTES });
    await sweep.sweep();
    expect(readBotDiskQuotaSignals(companyId)[0]).toMatchObject({
      overQuota: false,
      usageBytes: 800 * MBYTES,
      usageSource: "physical",
    });

    state.disk = disk({ usedBytes: 1001 * MBYTES });
    await sweep.sweep();
    expect(readBotDiskQuotaSignals(companyId)[0]).toMatchObject({ overQuota: true, usageBytes: 1001 * MBYTES });
    await fs.rm(volumeDir, { recursive: true, force: true });
  });

  it("an unreachable dockergate does not fail the tick: estimate usage, no PUT", async () => {
    const volumeDir = path.join(root, agentId);
    await fs.mkdir(volumeDir, { recursive: true });
    await fs.writeFile(path.join(volumeDir, "fill.bin"), Buffer.alloc(3 * MBYTES));
    const { gate, puts } = fakeGate({ disk: new Error("connect ENOENT") });
    const sweep = createBotDiskQuotaSweep({
      db: fakeDb([row()]),
      resolveSettings: settings(2),
      env: { [BOT_VOLUME_ROOT_ENV]: root },
      gate,
      remeasureIntervalMs: 0,
    });
    const result = await sweep.sweep();
    expect(result.measured).toBe(1);
    expect(puts).toEqual([]);
    expect(readBotDiskQuotaSignals(companyId)[0]).toMatchObject({ overQuota: true, usageSource: "estimate" });
    await fs.rm(volumeDir, { recursive: true, force: true });
  });

  it("a refused PUT is counted, not thrown, and retried only after the interval", async () => {
    const state = { disk: disk({ hardBytes: 1000 * MBYTES }) };
    const failing = {
      getDisk: async () => state.disk as never,
      putQuota: async () => {
        throw new Error("403 quota_unavailable");
      },
    };
    let t = 1_000_000;
    const sweep = createBotDiskQuotaSweep({
      db: fakeDb([row()]),
      resolveSettings: settings(2000),
      env: {},
      gate: failing,
      now: () => new Date(t),
      remeasureIntervalMs: 60_000,
    });
    expect((await sweep.sweep()).quotaPutFailed).toBe(1);
    expect((await sweep.sweep()).quotaPutFailed).toBe(0); // inside the backoff
    t += 61_000;
    expect((await sweep.sweep()).quotaPutFailed).toBe(1);
  });

  it("the quota is clamped to the contract bounds (a 10 MB quota is put as 64 MiB)", async () => {
    const { gate, puts } = fakeGate({ disk: disk({ hardBytes: 1000 * MBYTES }) });
    const sweep = createBotDiskQuotaSweep({ db: fakeDb([row()]), resolveSettings: settings(10), env: {}, gate });
    await sweep.sweep();
    expect(puts).toEqual([{ botKey: agentId, bytes: 64 * MBYTES }]);
  });
});
