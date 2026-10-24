import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  heartbeatRunScratchMetrics,
  prepareHeartbeatRunScratch,
  resetHeartbeatRunScratchMetrics,
} from "./run-scratch.js";
import {
  DEFAULT_RUN_SCRATCH_SWEEP_INTERVAL_MINUTES,
  DEFAULT_RUN_SCRATCH_TTL_HOURS,
  resolveRunScratchSweeperConfig,
  runRunScratchSweep,
} from "./run-scratch-sweeper.js";

const logger = { info: () => undefined, warn: () => undefined };

describe("run scratch sweeper", () => {
  const cleanup = new Set<string>();
  beforeEach(() => resetHeartbeatRunScratchMetrics());
  afterEach(async () => {
    for (const dir of cleanup) await fs.rm(dir, { recursive: true, force: true });
    cleanup.clear();
  });

  it("reads interval and ttl from settings and falls back on bad values", () => {
    expect(resolveRunScratchSweeperConfig(() => undefined)).toEqual({
      intervalMs: DEFAULT_RUN_SCRATCH_SWEEP_INTERVAL_MINUTES * 60_000,
      ttlMs: DEFAULT_RUN_SCRATCH_TTL_HOURS * 3_600_000,
    });
    const env: Record<string, string> = { RUN_SCRATCH_SWEEP_INTERVAL_MINUTES: "5", RUN_SCRATCH_TTL_HOURS: "2" };
    expect(resolveRunScratchSweeperConfig((name) => env[name])).toEqual({ intervalMs: 300_000, ttlMs: 7_200_000 });
    const bad: Record<string, string> = { RUN_SCRATCH_SWEEP_INTERVAL_MINUTES: "0", RUN_SCRATCH_TTL_HOURS: "abc" };
    expect(resolveRunScratchSweeperConfig((name) => bad[name]).ttlMs).toBe(DEFAULT_RUN_SCRATCH_TTL_HOURS * 3_600_000);
  });

  it("sweeps expired directories and exports the volume through the metrics state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-sweeper-test-"));
    cleanup.add(root);
    const expired = await prepareHeartbeatRunScratch({
      companyId: "c", agentId: "a", runId: "expired", now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const fresh = await prepareHeartbeatRunScratch({
      companyId: "c", agentId: "a", runId: "fresh", now: new Date("2026-01-02T00:00:00.000Z"),
    });
    await fs.rename(expired.dir, path.join(root, path.basename(expired.dir)));
    await fs.rename(fresh.dir, path.join(root, path.basename(fresh.dir)));

    const result = await runRunScratchSweep({
      root, now: new Date("2026-01-03T00:00:00.000Z"), ttlMs: 36 * 3_600_000, logger,
    });

    expect(result).toMatchObject({ removed: 1, remaining: 1 });
    const metrics = heartbeatRunScratchMetrics();
    expect(metrics.removedDirsTotal).toBe(1);
    expect(metrics.removedBytesTotal).toBe(result!.removedBytes);
    expect(metrics.remainingDirs).toBe(1);
    expect(metrics.remainingBytes).toBe(result!.remainingBytes);
    expect(metrics.lastSweepAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("does not throw when the root is unreadable", async () => {
    const result = await runRunScratchSweep({ root: "/nonexistent-run-scratch-root", ttlMs: 1, logger });
    expect(result).toBeNull();
  });
});
