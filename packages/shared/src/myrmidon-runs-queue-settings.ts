// myrmidon(1.7, OPE-4096, SETTINGS-TO-UI B): runs & queue behavior settings
// registered in the part A registry (instance scope, section "runs-queue").
// These keys resolve live (UI value → env forced override → default) and apply
// without a restart; consumers read them through
// server/src/myrmidon/runs-queue-settings/live.ts, never by caching env at
// startup.
//
// Composition follows ia-v2 §10.7 (OPE-3923): the rows marked "⟶ UI". Sweep
// intervals and page sizes that §10.7 keeps as deployment values
// (RUN_STALL_SWEEP_INTERVAL_SEC / PAGE_SIZE, TASK_PR_SYNC_POLL_SEC /
// BATCH_MAX, IDLE_PICKUP wake budget/batch, …) stay env-only and are NOT
// registered here. CONTINUATION_HISTORY_LIMIT is registered because §10.7
// marks it "⟶ UI".
//
// UI grouping (§10.16 recommendation): the keys whose `uiGroup` is "main" sit
// in the tab's main switch block; everything else lives under the collapsible
// "Тонкие настройки" (fine-tuning) sub-section.

import {
  behaviorSettingRegistry,
  type BehaviorSettingDef,
} from "./myrmidon-behavior-settings.js";

/** Boolean from a stored boolean or an env-style string. */
export function validateRunsQueueBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lower)) return true;
    if (["false", "0", "no", "off"].includes(lower)) return false;
  }
  return null;
}

/** Integer within [min, max] from a stored number or an env-style string. */
export function validateRunsQueueIntRange(min: number, max: number) {
  return (value: unknown): number | null => {
    const num =
      typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
    if (Number.isInteger(num) && num >= min && num <= max) return num;
    return null;
  };
}

/** Comma-separated string / string array → trimmed non-empty list. */
function validateStringList(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const out = value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
    return out.length > 0 ? out : null;
  }
  if (typeof value === "string") {
    const out = value.split(",").map((v) => v.trim()).filter(Boolean);
    return out.length > 0 ? out : null;
  }
  return null;
}

/** Non-empty trimmed string (a document key, a window spec, …). */
function validateNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const RUNS_QUEUE_SECTION = "runs-queue";

/** Whether the key renders in the tab's main block or under fine-tuning. */
export type RunsQueueUiGroup = "main" | "advanced";

export interface RunsQueueSettingDef<T> extends BehaviorSettingDef<T> {
  uiGroup: RunsQueueUiGroup;
}

function register<T>(def: RunsQueueSettingDef<T>): void {
  behaviorSettingRegistry.register(def);
}

const intRange = validateRunsQueueIntRange;

// --- Idle pickup (IDLE-PICKUP) ---------------------------------------------

register({
  key: "runsQueue.idlePickup.enabled",
  envName: "MYRMIDON_IDLE_PICKUP_ENABLED",
  default: true,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "boolean",
  validate: validateRunsQueueBoolean,
  uiGroup: "main",
});

register({
  key: "runsQueue.idlePickup.intervalSec",
  envName: "MYRMIDON_IDLE_PICKUP_INTERVAL_SEC",
  default: 30,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(5, Number.MAX_SAFE_INTEGER),
  uiGroup: "main",
});

register({
  key: "runsQueue.idlePickup.recentSuccessWindowMs",
  envName: "MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS",
  default: 15 * 60 * 1000,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "main",
});

// --- Run stall (RUN-STALL) ---------------------------------------------------

register({
  key: "runsQueue.runStall.enabled",
  envName: "MYRMIDON_RUN_STALL_ENABLED",
  default: true,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "boolean",
  validate: validateRunsQueueBoolean,
  uiGroup: "main",
});

register({
  key: "runsQueue.runStall.thresholdSec",
  envName: "MYRMIDON_RUN_STALL_THRESHOLD_SEC",
  default: 20 * 60,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(60, 24 * 60 * 60),
  uiGroup: "main",
});

// --- Auto resume (AUTO-RESUME) ----------------------------------------------

register({
  key: "runsQueue.autoResume.enabled",
  envName: "MYRMIDON_AUTO_RESUME_ENABLED",
  default: true,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "boolean",
  validate: validateRunsQueueBoolean,
  uiGroup: "main",
});

register({
  key: "runsQueue.autoResume.backoffMs",
  envName: "MYRMIDON_AUTO_RESUME_BACKOFF_MS",
  default: [60_000, 300_000, 900_000],
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "json",
  validate: (value: unknown): number[] | null => {
    const parts = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : null;
    if (!parts) return null;
    const parsed = parts
      .map((part) => (typeof part === "number" ? part : Number(String(part).trim())))
      .filter((part) => Number.isSafeInteger(part) && part > 0);
    return parsed.length > 0 ? parsed : null;
  },
  uiGroup: "advanced",
});

register({
  key: "runsQueue.autoResume.maxAttempts",
  envName: "MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS",
  default: 3,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(1, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.autoResume.intervalSec",
  envName: "MYRMIDON_AUTO_RESUME_INTERVAL_SEC",
  default: 60,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(10, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.autoResume.windowMs",
  envName: "MYRMIDON_AUTO_RESUME_WINDOW_MS",
  default: 60 * 60 * 1000,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(1, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

// --- Pauses & wakes -----------------------------------------------------------

register({
  key: "runsQueue.pauseDrains.enabled",
  envName: "MYRMIDON_PAUSE_DRAINS",
  default: true,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "boolean",
  validate: validateRunsQueueBoolean,
  uiGroup: "main",
});

register({
  key: "runsQueue.pauseResumeWake.batch",
  envName: "MYRMIDON_PAUSE_RESUME_WAKE_BATCH",
  default: 5,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.pauseResumeWake.batchPauseMs",
  envName: "MYRMIDON_PAUSE_RESUME_WAKE_BATCH_PAUSE_MS",
  default: 1000,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.skipIdleHeartbeats.enabled",
  envName: "MYRMIDON_SKIP_IDLE_HEARTBEATS",
  default: false,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "boolean",
  validate: validateRunsQueueBoolean,
  uiGroup: "main",
});

// --- Wake delivery -------------------------------------------------------------

register({
  key: "runsQueue.pendingInteractionWake.graceMs",
  envName: "MYRMIDON_PENDING_INTERACTION_WAKE_GRACE_MS",
  default: 10 * 60 * 1000,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.pendingInteractionWake.reAdmissions",
  envName: "MYRMIDON_PENDING_INTERACTION_WAKE_RE_ADMISSIONS",
  default: 1,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.outboxSweep.ageMs",
  envName: "MYRMIDON_OUTBOX_SWEEP_AGE_MS",
  default: 45_000,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

// --- Stranded runs -----------------------------------------------------------------

register({
  key: "runsQueue.strandedAutopolicy.enabled",
  envName: "MYRMIDON_STRANDED_AUTOPOLICY_ENABLED",
  default: true,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "boolean",
  validate: validateRunsQueueBoolean,
  uiGroup: "main",
});

register({
  key: "runsQueue.strandedAutopolicy.autoRetriesPerDay",
  envName: "MYRMIDON_STRANDED_AUTO_RETRIES_PER_DAY",
  default: 2,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.settledHolds.blockExplicitWakes",
  envName: "MYRMIDON_SETTLED_HOLDS_BLOCK_EXPLICIT_WAKES",
  default: false,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "boolean",
  validate: validateRunsQueueBoolean,
  uiGroup: "advanced",
});

// --- Run pipeline fine-tuning ----------------------------------------------------------

register({
  key: "runsQueue.infraInterrupt.codes",
  envName: "MYRMIDON_INFRA_INTERRUPT_CODES",
  default: ["agent_paused", "process_lost", "server_shutdown_interrupted", "issue_reassigned"],
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "json",
  validate: validateStringList,
  uiGroup: "advanced",
});

register({
  key: "runsQueue.writeLock.requiresLiveRun",
  envName: "MYRMIDON_WRITE_LOCK_REQUIRES_LIVE_RUN",
  default: true,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "boolean",
  validate: validateRunsQueueBoolean,
  uiGroup: "advanced",
});

register({
  key: "runsQueue.crossIssueInfluence.limit",
  envName: "MYRMIDON_CROSS_ISSUE_INFLUENCE_LIMIT",
  default: 20,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(1, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.continuationHistory.limit",
  envName: "MYRMIDON_CONTINUATION_HISTORY_LIMIT",
  default: 30,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.staleLease.graceMs",
  envName: "MYRMIDON_STALE_LEASE_GRACE_MS",
  default: 10 * 60 * 1000,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

// --- Task ↔ PR sync (TASK-PR-SYNC; poll/batch stay env per §10.7) ---------------------

register({
  key: "runsQueue.taskPrSync.enabled",
  envName: "MYRMIDON_TASK_PR_SYNC_ENABLED",
  default: true,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "boolean",
  validate: validateRunsQueueBoolean,
  uiGroup: "main",
});

// --- Swarm ----------------------------------------------------------------------

register({
  key: "runsQueue.swarm.supervisorTaskMax",
  envName: "MYRMIDON_SWARM_SUPERVISOR_TASK_MAX",
  default: 500,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(1, 5000),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.swarm.pilotBaselineDoc",
  envName: "MYRMIDON_SWARM_PILOT_BASELINE_DOC",
  default: "baseline-snapshot-14d",
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "string",
  validate: validateNonEmptyString,
  uiGroup: "advanced",
});

// --- DB backup catch-up --------------------------------------------------------------

register({
  key: "runsQueue.dbBackup.catchupWindow",
  envName: "MYRMIDON_DB_BACKUP_CATCHUP_WINDOW",
  default: "",
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "string",
  // Empty string means "no catch-up window" (feature off); a non-empty value
  // must look like "Europe/Moscow 03:00-05:00" and is validated further by
  // the backup-catch-up module itself.
  validate: (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed === "") return "";
    return /^(\S+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.test(trimmed) ? trimmed : null;
  },
  uiGroup: "advanced",
});

// --- Workspace hygiene -----------------------------------------------------------------

register({
  key: "runsQueue.workspaceHygiene.mergedCooldownMs",
  envName: "MYRMIDON_WORKSPACE_MERGED_COOLDOWN_MS",
  default: 30 * 60 * 1000,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

register({
  key: "runsQueue.workspaceHygiene.stuckSignalAfterMs",
  envName: "MYRMIDON_WORKSPACE_STUCK_SIGNAL_AFTER_MS",
  default: 24 * 60 * 60 * 1000,
  scope: "instance",
  section: RUNS_QUEUE_SECTION,
  valueType: "number",
  validate: intRange(0, Number.MAX_SAFE_INTEGER),
  uiGroup: "advanced",
});

/** The registered runs-queue keys, in registration order (UI render order). */
export const RUNS_QUEUE_SETTING_KEYS = [
  "runsQueue.idlePickup.enabled",
  "runsQueue.idlePickup.intervalSec",
  "runsQueue.idlePickup.recentSuccessWindowMs",
  "runsQueue.runStall.enabled",
  "runsQueue.runStall.thresholdSec",
  "runsQueue.autoResume.enabled",
  "runsQueue.autoResume.backoffMs",
  "runsQueue.autoResume.maxAttempts",
  "runsQueue.autoResume.intervalSec",
  "runsQueue.autoResume.windowMs",
  "runsQueue.pauseDrains.enabled",
  "runsQueue.pauseResumeWake.batch",
  "runsQueue.pauseResumeWake.batchPauseMs",
  "runsQueue.skipIdleHeartbeats.enabled",
  "runsQueue.pendingInteractionWake.graceMs",
  "runsQueue.pendingInteractionWake.reAdmissions",
  "runsQueue.outboxSweep.ageMs",
  "runsQueue.strandedAutopolicy.enabled",
  "runsQueue.strandedAutopolicy.autoRetriesPerDay",
  "runsQueue.settledHolds.blockExplicitWakes",
  "runsQueue.infraInterrupt.codes",
  "runsQueue.writeLock.requiresLiveRun",
  "runsQueue.crossIssueInfluence.limit",
  "runsQueue.continuationHistory.limit",
  "runsQueue.staleLease.graceMs",
  "runsQueue.taskPrSync.enabled",
  "runsQueue.swarm.supervisorTaskMax",
  "runsQueue.swarm.pilotBaselineDoc",
  "runsQueue.dbBackup.catchupWindow",
  "runsQueue.workspaceHygiene.mergedCooldownMs",
  "runsQueue.workspaceHygiene.stuckSignalAfterMs",
] as const;

export type RunsQueueSettingKey = (typeof RUNS_QUEUE_SETTING_KEYS)[number];
