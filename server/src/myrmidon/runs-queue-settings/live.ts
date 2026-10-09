// myrmidon(1.7, OPE-4096, SETTINGS-TO-UI B): live readers for the runs & queue
// behavior settings. Each helper resolves the value through the part A
// process-wide view (stored UI value → env forced override → default); the env
// argument only provides the forced-override layer so consumers that already
// hold a specific env (tests, startup probes) keep working unchanged.

import "@paperclipai/shared/myrmidon-runs-queue-settings.js"; // registers the keys
import { liveBehaviorSetting } from "../behavior-settings/live.js";

function envOverride<T>(
  env: NodeJS.ProcessEnv,
  envName: string,
  parse: (raw: string) => T | null,
): T | null {
  const raw = env[envName]?.trim();
  if (!raw) return null;
  return parse(raw);
}

function parseBoolean(raw: string): boolean | null {
  const lower = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return null;
}

function parseIntInRange(min: number, max: number) {
  return (raw: string): number | null => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return null;
    return value;
  };
}

function parseIntList(raw: string): number[] | null {
  const out = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (/^\d+$/.test(v) ? Number(v) : NaN))
    .filter((v) => Number.isSafeInteger(v) && v > 0);
  return out.length > 0 ? out : null;
}

function parseStringList(raw: string): string[] | null {
  const out = raw.split(",").map((v) => v.trim()).filter(Boolean);
  return out.length > 0 ? out : null;
}

function resolve<T>(
  env: NodeJS.ProcessEnv,
  envName: string,
  key: string,
  parse: (raw: string) => T | null,
  defaultValue: T,
): T {
  const override = envOverride(env, envName, parse);
  if (override !== null) return override;
  return liveBehaviorSetting<T>(key) ?? defaultValue;
}

/** Idle pickup: find idle-but-productive agents and wake them (IDLE-PICKUP). */
export function liveIdlePickupSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: resolve(env, "MYRMIDON_IDLE_PICKUP_ENABLED", "runsQueue.idlePickup.enabled", parseBoolean, true),
    intervalSec: resolve(env, "MYRMIDON_IDLE_PICKUP_INTERVAL_SEC", "runsQueue.idlePickup.intervalSec", parseIntInRange(5, Number.MAX_SAFE_INTEGER), 30),
    recentSuccessWindowMs: resolve(env, "MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS", "runsQueue.idlePickup.recentSuccessWindowMs", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 15 * 60 * 1000),
  };
}

/** Run-stall detection: a run that made no progress within the threshold (RUN-STALL). */
export function liveRunStallSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: resolve(env, "MYRMIDON_RUN_STALL_ENABLED", "runsQueue.runStall.enabled", parseBoolean, true),
    thresholdSec: resolve(env, "MYRMIDON_RUN_STALL_THRESHOLD_SEC", "runsQueue.runStall.thresholdSec", parseIntInRange(60, 24 * 60 * 60), 20 * 60),
  };
}

/** Auto-resume from error: backoff steps, attempt cap, sweep gate, failure-series window. */
export function liveAutoResumeSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: resolve(env, "MYRMIDON_AUTO_RESUME_ENABLED", "runsQueue.autoResume.enabled", parseBoolean, true),
    backoffMs: resolve(env, "MYRMIDON_AUTO_RESUME_BACKOFF_MS", "runsQueue.autoResume.backoffMs", parseIntList, [60_000, 300_000, 900_000]),
    maxAttempts: resolve(env, "MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS", "runsQueue.autoResume.maxAttempts", parseIntInRange(1, Number.MAX_SAFE_INTEGER), 3),
    intervalSec: resolve(env, "MYRMIDON_AUTO_RESUME_INTERVAL_SEC", "runsQueue.autoResume.intervalSec", parseIntInRange(10, Number.MAX_SAFE_INTEGER), 60),
    windowMs: resolve(env, "MYRMIDON_AUTO_RESUME_WINDOW_MS", "runsQueue.autoResume.windowMs", parseIntInRange(1, Number.MAX_SAFE_INTEGER), 60 * 60 * 1000),
  };
}

/** Pauses & wakes: pause drains the queue instead of aborting; resume wakes go out in batches. */
export function livePauseWakeSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    pauseDrainsEnabled: resolve(env, "MYRMIDON_PAUSE_DRAINS", "runsQueue.pauseDrains.enabled", parseBoolean, true),
    resumeWakeBatch: resolve(env, "MYRMIDON_PAUSE_RESUME_WAKE_BATCH", "runsQueue.pauseResumeWake.batch", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 5),
    resumeWakeBatchPauseMs: resolve(env, "MYRMIDON_PAUSE_RESUME_WAKE_BATCH_PAUSE_MS", "runsQueue.pauseResumeWake.batchPauseMs", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 1000),
    skipIdleHeartbeats: resolve(env, "MYRMIDON_SKIP_IDLE_HEARTBEATS", "runsQueue.skipIdleHeartbeats.enabled", parseBoolean, false),
  };
}

/** Wake delivery: pending-interaction grace, re-admissions, outbox sweep age. */
export function liveWakeDeliverySettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    pendingInteractionGraceMs: resolve(env, "MYRMIDON_PENDING_INTERACTION_WAKE_GRACE_MS", "runsQueue.pendingInteractionWake.graceMs", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 10 * 60 * 1000),
    pendingInteractionReAdmissions: resolve(env, "MYRMIDON_PENDING_INTERACTION_WAKE_RE_ADMISSIONS", "runsQueue.pendingInteractionWake.reAdmissions", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 1),
    outboxSweepAgeMs: resolve(env, "MYRMIDON_OUTBOX_SWEEP_AGE_MS", "runsQueue.outboxSweep.ageMs", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 45_000),
  };
}

/** Stranded runs: autopolicy, retries per day, settled-holds blocking explicit wakes. */
export function liveStrandedSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: resolve(env, "MYRMIDON_STRANDED_AUTOPOLICY_ENABLED", "runsQueue.strandedAutopolicy.enabled", parseBoolean, true),
    autoRetriesPerDay: resolve(env, "MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY", "runsQueue.strandedAutopolicy.autoRetriesPerDay", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 2),
    settledHoldsBlockExplicitWakes: resolve(env, "MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES", "runsQueue.settledHolds.blockExplicitWakes", parseBoolean, false),
  };
}

/** Fine-tuning: infra interrupt codes, write lock, cross-issue influence, continuation history, stale lease grace. */
export function liveRunPipelineSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    infraInterruptCodes: resolve(env, "MYRMIDON_INFRA_INTERRUPT_CODES", "runsQueue.infraInterrupt.codes", parseStringList, ["agent_paused", "process_lost", "server_shutdown_interrupted", "issue_reassigned"]),
    writeLockRequiresLiveRun: resolve(env, "MYRMIDON_WRITE_LOCK_REQUIRES_LIVE_RUN", "runsQueue.writeLock.requiresLiveRun", parseBoolean, true),
    crossIssueInfluenceLimit: resolve(env, "MYRMIDON_CROSS_ISSUE_INFLUENCE_LIMIT", "runsQueue.crossIssueInfluence.limit", parseIntInRange(1, Number.MAX_SAFE_INTEGER), 20),
    continuationHistoryLimit: resolve(env, "MYRMIDON_CONTINUATION_HISTORY_LIMIT", "runsQueue.continuationHistory.limit", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 30),
    staleLeaseGraceMs: resolve(env, "MYRMIDON_STALE_LEASE_GRACE_MS", "runsQueue.staleLease.graceMs", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 10 * 60 * 1000),
  };
}

/** Task ↔ PR sync (poll/batch stay env-only per ia-v2 §10.7). */
export function liveTaskPrSyncSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: resolve(env, "MYRMIDON_TASK_PR_SYNC_ENABLED", "runsQueue.taskPrSync.enabled", parseBoolean, true),
  };
}

/** Swarm: supervisor task ceiling and pilot baseline document. */
export function liveSwarmSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    supervisorTaskMax: resolve(env, "MYRMIDON_SWARM_SUPERVISOR_TASK_MAX", "runsQueue.swarm.supervisorTaskMax", parseIntInRange(1, 5000), 500),
    pilotBaselineDoc: resolve(env, "MYRMIDON_SWARM_PILOT_BASELINE_DOC", "runsQueue.swarm.pilotBaselineDoc", (raw) => (raw.trim().length > 0 ? raw.trim() : null), "baseline-snapshot-14d"),
  };
}

/** DB backup catch-up window (empty = off). */
export function liveDbBackupCatchupWindow(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env, "MYRMIDON_DB_BACKUP_CATCHUP_WINDOW", "runsQueue.dbBackup.catchupWindow", (raw) => {
    const trimmed = raw.trim();
    if (trimmed === "") return "";
    return /^(\S+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.test(trimmed) ? trimmed : null;
  }, "");
}

/** Workspace hygiene: cooldown for merged worktrees and stuck-signal threshold. */
export function liveWorkspaceHygieneSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    mergedCooldownMs: resolve(env, "MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS", "runsQueue.workspaceHygiene.mergedCooldownMs", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 30 * 60 * 1000),
    stuckSignalAfterMs: resolve(env, "MYRMIDON_WORKSPACE_STUCK_SIGNAL_AFTER_MS", "runsQueue.workspaceHygiene.stuckSignalAfterMs", parseIntInRange(0, Number.MAX_SAFE_INTEGER), 24 * 60 * 60 * 1000),
  };
}
