// myrmidon(1.6.7 SETTINGS-GENERAL-CRASH): the data model of the Runs & Queue
// settings tab. `GET /api/myrmidon/behavior-settings` answers
// `{ settings, sources }` (flat key -> value and key -> "ui" | "env" |
// "default"; see server/src/myrmidon/behavior-settings/routes.ts and
// behaviorSettingsApi.ts). The tab used to read a `values[]` array the server
// never sent, so opening Settings -> General threw "values is not iterable"
// and the whole page fell to the error screen. `readRunsQueueItems` is the one
// place that reads the response: it never throws, and answers `null` for a
// body that is not the `{ settings, sources }` shape so the panel can show an
// error inside itself. No imports, so it runs in any test.

export const RUNS_QUEUE_KEYS = [
  "runsQueue.idlePickup.wakeBudgetPerMin",
  "runsQueue.idlePickup.wakeBatch",
  "runsQueue.idlePickup.enabled",
  "runsQueue.idlePickup.intervalSec",
  "runsQueue.idlePickup.recentSuccessWindowMs",
  "runsQueue.runStall.enabled",
  "runsQueue.runStall.thresholdSec",
  "runsQueue.autoResume.enabled",
  "runsQueue.autoResume.maxAttempts",
  "runsQueue.autoResume.intervalSec",
  "runsQueue.autoResume.windowMs",
  "runsQueue.autoResume.backoffMs",
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

export type RunsQueueKey = (typeof RUNS_QUEUE_KEYS)[number];
export type RunsQueueValueType = "boolean" | "string" | "number" | "json";
export type RunsQueueSource = "ui" | "env" | "default";

/** One setting of the tab, as the panel renders it. */
export interface RunsQueueItem {
  key: RunsQueueKey;
  value: unknown;
  source: RunsQueueSource;
  valueType: RunsQueueValueType;
}

/** Keys whose value is a list of numbers (the rest of the list keys hold strings). */
const NUMBER_LIST_KEYS: ReadonlySet<string> = new Set(["runsQueue.autoResume.backoffMs"]);

const KEY_SET: ReadonlySet<string> = new Set(RUNS_QUEUE_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The control a value needs, from the value the server serves (the view carries no definitions). */
export function inferValueType(value: unknown): RunsQueueValueType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value) || isRecord(value)) return "json";
  return "string";
}

function readSource(value: unknown): RunsQueueSource {
  return value === "ui" || value === "env" ? value : "default";
}

/**
 * The Runs & Queue settings of a `GET /myrmidon/behavior-settings` response,
 * in the tab's key order. A key the server does not serve (an older server)
 * is left out. Returns `null` when `data` is not a `{ settings }` object —
 * the caller shows an error inside the panel; this function never throws.
 */
export function readRunsQueueItems(data: unknown): RunsQueueItem[] | null {
  if (!isRecord(data) || !isRecord(data.settings)) return null;
  const settings = data.settings;
  const sources = isRecord(data.sources) ? data.sources : {};
  const items: RunsQueueItem[] = [];
  for (const key of RUNS_QUEUE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    const value = settings[key];
    items.push({ key, value, source: readSource(sources[key]), valueType: inferValueType(value) });
  }
  return items;
}

/** Whether a key belongs to the tab (the PATCH sends nothing else). */
export function isRunsQueueKey(key: string): key is RunsQueueKey {
  return KEY_SET.has(key);
}

/** The text of a list value in the input: items joined by ", ". */
export function formatRunsQueueValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
  return value === null || value === undefined ? "" : String(value);
}

export type RunsQueueParse = { ok: true; value: unknown } | { ok: false };

/**
 * The value to send for text typed into a field of the given item. Numbers
 * must be finite; the two list keys are comma-separated (numbers for the
 * back-off, strings for the interrupt codes); a plain string is sent as typed
 * (an empty catch-up window means "off"). The server validates the range.
 */
export function parseRunsQueueInput(item: Pick<RunsQueueItem, "key" | "valueType">, raw: unknown): RunsQueueParse {
  if (item.valueType === "boolean") return typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false };
  if (item.valueType === "number") {
    const text = typeof raw === "string" ? raw.trim() : raw;
    if (text === "" || text === null || text === undefined) return { ok: false };
    const next = typeof text === "number" ? text : Number(text);
    return Number.isFinite(next) ? { ok: true, value: next } : { ok: false };
  }
  if (item.valueType === "json") {
    const parts = (Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(","))
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) return { ok: false };
    if (!NUMBER_LIST_KEYS.has(item.key)) return { ok: true, value: parts };
    const numbers = parts.map(Number);
    return numbers.every((n) => Number.isFinite(n)) ? { ok: true, value: numbers } : { ok: false };
  }
  return { ok: true, value: raw === null || raw === undefined ? "" : String(raw) };
}

/** True when the typed value differs from the one the server serves. */
export function runsQueueValueChanged(served: unknown, next: unknown): boolean {
  return JSON.stringify(served) !== JSON.stringify(next);
}
