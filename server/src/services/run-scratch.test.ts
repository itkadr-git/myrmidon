import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  buildHeartbeatRunScratchEnv,
  cleanupHeartbeatRunScratch,
  prepareHeartbeatRunScratch,
  sweepHeartbeatRunScratch,
  type HeartbeatRunScratch,
} from "./run-scratch.js";

const cleanupDirs = new Set<string>();

async function trackScratch(scratch: HeartbeatRunScratch) {
  cleanupDirs.add(scratch.dir);
  return scratch;
}

afterEach(async () => {
  await Promise.all(
    Array.from(cleanupDirs, (dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
  cleanupDirs.clear();
});

describe("heartbeat run scratch cleanup", () => {
  it("removes only a marked run-owned scratch directory", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "PAP-13071",
      now: new Date("2026-07-08T00:00:00.000Z"),
    }));
    await fs.writeFile(path.join(scratch.dir, "tool-cache.txt"), "cache");

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: true, dir: scratch.dir, bytes: 197 });
    await expect(fs.stat(scratch.dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves paperclip-named directories without the ownership marker", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-unmarked-"));
    cleanupDirs.add(dir);
    const scratch: HeartbeatRunScratch = {
      dir,
      runDir: path.join(dir, "run-dir"),
      markerPath: path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      metadata: {
        version: 1,
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date("2026-07-08T00:00:00.000Z").toISOString(),
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch });

    expect(result).toEqual({ removed: false, dir, bytes: 0, reason: "unmarked" });
    await expect(fs.stat(dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("preserves marked scratch when the marker owner does not match the run", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));
    const mismatched = {
      ...scratch,
      metadata: {
        ...scratch.metadata,
        runId: "run-2",
      },
    };

    const result = await cleanupHeartbeatRunScratch({ scratch: mismatched });

    expect(result).toEqual({ removed: false, dir: scratch.dir, bytes: 0, reason: "owner_mismatch" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("skips cleanup while the run process group is still alive", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = await cleanupHeartbeatRunScratch({
      scratch,
      processGroupId: 123,
      isProcessGroupAlive: () => true,
    });

    expect(result).toEqual({ removed: false, dir: scratch.dir, bytes: 0, reason: "process_group_alive" });
    await expect(fs.stat(scratch.dir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("sweeps only marked expired run directories and reports removed bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-sweep-test-"));
    cleanupDirs.add(root);
    const expired = await prepareHeartbeatRunScratch({
      companyId: "company-1", agentId: "agent-1", runId: "expired", now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const fresh = await prepareHeartbeatRunScratch({
      companyId: "company-1", agentId: "agent-1", runId: "fresh", now: new Date("2026-01-02T00:00:00.000Z"),
    });
    cleanupDirs.add(expired.dir);
    cleanupDirs.add(fresh.dir);
    // Move fixtures below the isolated sweep root and refresh the returned paths.
    const expiredDir = path.join(root, path.basename(expired.dir));
    const freshDir = path.join(root, path.basename(fresh.dir));
    await fs.rename(expired.dir, expiredDir);
    await fs.rename(fresh.dir, freshDir);
    cleanupDirs.delete(expired.dir);
    cleanupDirs.delete(fresh.dir);
    const markerPath = path.join(expiredDir, HEARTBEAT_RUN_SCRATCH_MARKER);
    await fs.writeFile(path.join(expiredDir, "payload"), "12345");

    const expectedBytes = (await fs.stat(markerPath)).size + Buffer.byteLength("12345");
    const result = await sweepHeartbeatRunScratch({
      root, now: new Date("2026-01-03T00:00:00.000Z"), ttlMs: 36 * 60 * 60 * 1000,
    });

    const freshBytes = (await fs.stat(path.join(freshDir, HEARTBEAT_RUN_SCRATCH_MARKER))).size;
    expect(result).toEqual({
      scanned: 2,
      removed: 1,
      removedBytes: expectedBytes,
      skipped: 1,
      remaining: 1,
      remainingBytes: freshBytes,
    });
    await expect(fs.stat(expiredDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(freshDir)).resolves.toBeDefined();
  });

  it("does not sweep unmarked similarly named directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-sweep-unmarked-"));
    cleanupDirs.add(root);
    const dir = await fs.mkdtemp(path.join(root, "paperclip-run-unmarked-"));
    const result = await sweepHeartbeatRunScratch({ root, now: new Date(), ttlMs: 0 });
    expect(result).toEqual({
      scanned: 1,
      removed: 0,
      removedBytes: 0,
      skipped: 1,
      remaining: 0,
      remainingBytes: 0,
    });
    await expect(fs.stat(dir)).resolves.toBeDefined();
  });

  it("builds explicit scratch env without clobbering configured temp dirs", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = buildHeartbeatRunScratchEnv({ TMPDIR: "/custom/tmp" }, scratch);

    expect(result.env.PAPERCLIP_RUN_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_TASK_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.PAPERCLIP_RUN_DIR).toBe(scratch.runDir);
    expect(result.env.CHROME_USER_DATA_DIR).toBe(scratch.runDir);
    expect(result.env.PAPERCLIP_TMPDIR).toBe(scratch.dir);
    // myrmidon(REBRAND-C): canonical names ship alongside the legacy alias.
    expect(result.env.MYRMIDON_RUN_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.MYRMIDON_TASK_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.MYRMIDON_SCRATCH_DIR).toBe(scratch.dir);
    expect(result.env.MYRMIDON_RUN_DIR).toBe(scratch.runDir);
    expect(result.env.MYRMIDON_TMPDIR).toBe(scratch.dir);
    expect(result.env.TMPDIR).toBeUndefined();
    expect(result.env.TEMP).toBe(scratch.dir);
    expect(result.env.TMP).toBe(scratch.dir);
    expect(result.tempKeysApplied).toEqual(["TEMP", "TMP"]);
  });

  it("prepares run-dir inside scratch directory and configures browser profile env", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    expect(scratch.runDir).toBe(path.join(scratch.dir, "run-dir"));
    const stats = await fs.stat(scratch.runDir);
    expect(stats.isDirectory()).toBe(true);

    const result = buildHeartbeatRunScratchEnv({}, scratch);
    expect(result.env.PAPERCLIP_RUN_DIR).toBe(scratch.runDir);
    expect(result.env.MYRMIDON_RUN_DIR).toBe(scratch.runDir);
    expect(result.env.CHROME_USER_DATA_DIR).toBe(scratch.runDir);
  });

  it("preserves explicitly configured CHROME_USER_DATA_DIR", async () => {
    const scratch = await trackScratch(await prepareHeartbeatRunScratch({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    }));

    const result = buildHeartbeatRunScratchEnv({ CHROME_USER_DATA_DIR: "/custom/chrome" }, scratch);
    expect(result.env.CHROME_USER_DATA_DIR).toBeUndefined();
    expect(result.env.PAPERCLIP_RUN_DIR).toBe(scratch.runDir);
  });
});
