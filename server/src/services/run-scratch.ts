import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeProductEnv } from "@myrmidon/shared/env-alias"; // myrmidon(REBRAND-C)

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";

export interface HeartbeatRunScratchMetadata {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  createdAt: string;
}

export interface HeartbeatRunScratch {
  dir: string;
  runDir: string;
  markerPath: string;
  metadata: HeartbeatRunScratchMetadata;
}

export interface HeartbeatRunScratchEnvResult {
  env: Record<string, string>;
  tempKeysApplied: string[];
}

export type HeartbeatRunScratchCleanupResult =
  | { removed: true; dir: string; bytes: number }
  | { removed: false; dir: string; bytes: 0; reason: "missing" | "unmarked" | "owner_mismatch" | "process_group_alive" };

export interface HeartbeatRunScratchSweepResult {
  scanned: number;
  removed: number;
  removedBytes: number;
  skipped: number;
  /** Marked directories that stayed (not yet past TTL, or guarded), and their size. */
  remaining: number;
  remainingBytes: number;
}

/** Cumulative and last-sweep volume of the run scratch janitor, for the metrics endpoint. */
export interface HeartbeatRunScratchMetrics {
  removedDirsTotal: number;
  removedBytesTotal: number;
  remainingDirs: number;
  remainingBytes: number;
  /** ISO time of the last completed sweep, null before the first one. */
  lastSweepAt: string | null;
}

const scratchMetrics: HeartbeatRunScratchMetrics = {
  removedDirsTotal: 0,
  removedBytesTotal: 0,
  remainingDirs: 0,
  remainingBytes: 0,
  lastSweepAt: null,
};

export function recordHeartbeatRunScratchSweep(result: HeartbeatRunScratchSweepResult, at: Date = new Date()): void {
  scratchMetrics.removedDirsTotal += result.removed;
  scratchMetrics.removedBytesTotal += result.removedBytes;
  scratchMetrics.remainingDirs = result.remaining;
  scratchMetrics.remainingBytes = result.remainingBytes;
  scratchMetrics.lastSweepAt = at.toISOString();
}

export function heartbeatRunScratchMetrics(): HeartbeatRunScratchMetrics {
  return { ...scratchMetrics };
}

export function resetHeartbeatRunScratchMetrics(): void {
  scratchMetrics.removedDirsTotal = 0;
  scratchMetrics.removedBytesTotal = 0;
  scratchMetrics.remainingDirs = 0;
  scratchMetrics.remainingBytes = 0;
  scratchMetrics.lastSweepAt = null;
}

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const ISSUE_SEGMENT_MAX_CHARS = 32;

function sanitizePathSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ISSUE_SEGMENT_MAX_CHARS)
    .replace(/[.-]+$/g, "");
  return normalized || fallback;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readMarker(markerPath: string): Promise<HeartbeatRunScratchMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.agentId !== "string" ||
      typeof rec.runId !== "string" ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      companyId: rec.companyId,
      agentId: rec.agentId,
      runId: rec.runId,
      issueId: typeof rec.issueId === "string" ? rec.issueId : null,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

export async function prepareHeartbeatRunScratch(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  now?: Date;
}): Promise<HeartbeatRunScratch> {
  const issueSegment = sanitizePathSegment(input.issueIdentifier, "unassigned");
  const runSegment = sanitizePathSegment(input.runId.slice(0, 12), "run");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-run-${issueSegment}-${runSegment}-`));
  const runDir = path.join(dir, "run-dir");
  await fs.mkdir(runDir, { recursive: true });
  const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
  const metadata: HeartbeatRunScratchMetadata = {
    version: 1,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    issueId: input.issueId ?? null,
    issueIdentifier: input.issueIdentifier ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { dir, runDir, markerPath, metadata };
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await fs.stat(child)).size;
  }
  return total;
}

export function buildHeartbeatRunScratchEnv(
  existingEnv: Record<string, unknown>,
  scratch: HeartbeatRunScratch,
): HeartbeatRunScratchEnvResult {
  const runDir = scratch.runDir || path.join(scratch.dir, "run-dir");
  const env: Record<string, string> = {};
  // myrmidon(REBRAND-C): canonical MYRMIDON_* names plus the PAPERCLIP_* alias
  // so older bots keep resolving them through the transition.
  writeProductEnv(env, "RUN_SCRATCH_DIR", scratch.dir);
  writeProductEnv(env, "TASK_SCRATCH_DIR", scratch.dir);
  writeProductEnv(env, "SCRATCH_DIR", scratch.dir);
  writeProductEnv(env, "RUN_DIR", runDir);
  writeProductEnv(env, "TMPDIR", scratch.dir);

  if (
    typeof existingEnv.CHROME_USER_DATA_DIR !== "string" ||
    existingEnv.CHROME_USER_DATA_DIR.trim().length === 0
  ) {
    env.CHROME_USER_DATA_DIR = runDir;
  }
  const tempKeysApplied: string[] = [];
  for (const key of TEMP_ENV_KEYS) {
    const existing = existingEnv[key];
    if (typeof existing === "string" && existing.trim().length > 0) continue;
    env[key] = scratch.dir;
    tempKeysApplied.push(key);
  }
  return { env, tempKeysApplied };
}

export async function cleanupHeartbeatRunScratch(input: {
  scratch: HeartbeatRunScratch;
  processGroupId?: number | null;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
}): Promise<HeartbeatRunScratchCleanupResult> {
  const tmpRoot = path.resolve(os.tmpdir());
  const dir = path.resolve(input.scratch.dir);
  if (!isPathInside(tmpRoot, dir) || !path.basename(dir).startsWith("paperclip-run-")) {
    return { removed: false, dir, bytes: 0, reason: "unmarked" };
  }
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) return { removed: false, dir, bytes: 0, reason: "missing" };
  } catch {
    return { removed: false, dir, bytes: 0, reason: "missing" };
  }

  const marker = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
  if (!marker) return { removed: false, dir, bytes: 0, reason: "unmarked" };
  if (
    marker.companyId !== input.scratch.metadata.companyId ||
    marker.agentId !== input.scratch.metadata.agentId ||
    marker.runId !== input.scratch.metadata.runId
  ) {
    return { removed: false, dir, bytes: 0, reason: "owner_mismatch" };
  }
  if (input.isProcessGroupAlive?.(input.processGroupId) === true) {
    return { removed: false, dir, bytes: 0, reason: "process_group_alive" };
  }

  const bytes = await directoryBytes(dir);
  await fs.rm(dir, { recursive: true, force: true });
  return { removed: true, dir, bytes };
}

export async function sweepHeartbeatRunScratch(input: {
  root?: string;
  now?: Date;
  ttlMs: number;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
}): Promise<HeartbeatRunScratchSweepResult> {
  const root = path.resolve(input.root ?? os.tmpdir());
  const result: HeartbeatRunScratchSweepResult = {
    scanned: 0,
    removed: 0,
    removedBytes: 0,
    skipped: 0,
    remaining: 0,
    remainingBytes: 0,
  };
  const now = (input.now ?? new Date()).getTime();
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("paperclip-run-")) continue;
    result.scanned += 1;
    const dir = path.join(root, entry.name);
    const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
    const marker = await readMarker(markerPath);
    if (!marker || now - Date.parse(marker.createdAt) < input.ttlMs) {
      result.skipped += 1;
      if (marker) await keepRemaining(result, dir);
      continue;
    }
    const cleaned = await cleanupHeartbeatRunScratch({
      scratch: { dir, runDir: path.join(dir, "run-dir"), markerPath, metadata: marker },
      isProcessGroupAlive: input.isProcessGroupAlive,
    });
    if (cleaned.removed) {
      result.removed += 1;
      result.removedBytes += cleaned.bytes;
    } else {
      result.skipped += 1;
      await keepRemaining(result, dir);
    }
  }
  return result;
}

async function keepRemaining(result: HeartbeatRunScratchSweepResult, dir: string): Promise<void> {
  result.remaining += 1;
  try {
    result.remainingBytes += await directoryBytes(dir);
  } catch {
    // The directory vanished or is unreadable mid-sweep; it still counts as one entry.
  }
}
