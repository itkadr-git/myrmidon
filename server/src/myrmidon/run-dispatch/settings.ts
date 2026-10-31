// server/src/myrmidon/run-dispatch/settings.ts
//
// myrmidon(1.6.6 RUN-DISPATCH, OPE-6977): the settings contract of the run
// start dispatcher — `instance_settings.general.processes`:
//
//   general.processes.runStartDispatch  "inline" | "notify"   default "inline"
//   general.processes.queuedResweepSec  integer 5..3600       default 30
//   general.processes.queuedRunStaleAfterSec integer 60..604800 default 1800
//
// The stored row is read RAW on purpose. `instanceSettingsService(db).getGeneral()`
// builds its view from a whitelist (`normalizeGeneralSettings`, instance-settings.ts),
// so the stale age is read here because the operator-facing whitelist has not yet
// adopted this key. `general.processes.queuedRunStaleAfterSec` is therefore
// configurable through the stored process settings blob; malformed values fall back
// to the default rather than breaking a dispatcher pass.

import { eq } from "drizzle-orm";
import { instanceSettings, type Db } from "@myrmidon/db";

/** The `general.processes` key inside `instance_settings.general`. */
export const RUN_DISPATCH_SETTINGS_KEY = "processes";
/** `general.processes.runStartDispatch` — how a start attempt is dispatched. */
export const RUN_START_DISPATCH_KEY = "runStartDispatch";
/** `general.processes.queuedResweepSec` — the queued-run resweep interval. */
export const QUEUED_RESWEEP_SEC_KEY = "queuedResweepSec";
/** `general.processes.queuedRunStaleAfterSec` — max queued age before expiry. */
export const QUEUED_RUN_STALE_AFTER_SEC_KEY = "queuedRunStaleAfterSec";

export const RUN_START_DISPATCH_MODES = ["inline", "notify"] as const;
/**
 * `inline` — the process that decides to start runs the queued run itself
 * (the vendor behaviour, unchanged). `notify` — it publishes `run_queued` to the
 * process bus (design OPE-5394 section 3) and the executor process starts the run.
 */
export type RunStartDispatchMode = (typeof RUN_START_DISPATCH_MODES)[number];

export const DEFAULT_RUN_START_DISPATCH: RunStartDispatchMode = "inline";
export const DEFAULT_QUEUED_RESWEEP_SEC = 30;
export const DEFAULT_QUEUED_RUN_STALE_AFTER_SEC = 1800;
/** Floor of `queuedResweepSec`: below this the pass is a busy loop, not a fallback. */
export const MIN_QUEUED_RESWEEP_SEC = 5;
/** Ceiling of `queuedResweepSec`: above this the NOTIFY fallback is slower than the 5 min tick. */
export const MAX_QUEUED_RESWEEP_SEC = 3600;

/** The singleton row of `instance_settings` (see instance-settings.ts). */
const DEFAULT_SINGLETON_KEY = "default";

export interface RunDispatchSettings {
  runStartDispatch: RunStartDispatchMode;
  queuedResweepSec: number;
  queuedRunStaleAfterSec: number;
}

export const DEFAULT_RUN_DISPATCH_SETTINGS: RunDispatchSettings = {
  runStartDispatch: DEFAULT_RUN_START_DISPATCH,
  queuedResweepSec: DEFAULT_QUEUED_RESWEEP_SEC,
  queuedRunStaleAfterSec: DEFAULT_QUEUED_RUN_STALE_AFTER_SEC,
};

function readProcessesRecord(general: unknown): Record<string, unknown> | null {
  if (!general || typeof general !== "object" || Array.isArray(general)) return null;
  const processes = (general as Record<string, unknown>)[RUN_DISPATCH_SETTINGS_KEY];
  if (!processes || typeof processes !== "object" || Array.isArray(processes)) return null;
  return processes as Record<string, unknown>;
}

function resolveMode(raw: unknown): RunStartDispatchMode {
  if (typeof raw !== "string") return DEFAULT_RUN_START_DISPATCH;
  const normalized = raw.trim().toLowerCase();
  return (RUN_START_DISPATCH_MODES as readonly string[]).includes(normalized)
    ? (normalized as RunStartDispatchMode)
    : DEFAULT_RUN_START_DISPATCH;
}

function resolveIntervalSec(raw: unknown): number {
  const numeric =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_QUEUED_RESWEEP_SEC;
  const rounded = Math.round(numeric);
  if (rounded < MIN_QUEUED_RESWEEP_SEC) return MIN_QUEUED_RESWEEP_SEC;
  if (rounded > MAX_QUEUED_RESWEEP_SEC) return MAX_QUEUED_RESWEEP_SEC;
  return rounded;
}

function resolveStaleAfterSec(raw: unknown): number {
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(numeric)) return DEFAULT_QUEUED_RUN_STALE_AFTER_SEC;
  return Math.max(60, Math.min(604800, Math.round(numeric)));
}

/**
 * Resolve the dispatcher settings out of a raw `instance_settings.general` value.
 * Pure, so the tests can drive every malformed shape without a database.
 */
export function resolveRunDispatchSettings(general: unknown): RunDispatchSettings {
  const processes = readProcessesRecord(general);
  if (!processes) return { ...DEFAULT_RUN_DISPATCH_SETTINGS };
  return {
    runStartDispatch: resolveMode(processes[RUN_START_DISPATCH_KEY]),
    queuedResweepSec: resolveIntervalSec(processes[QUEUED_RESWEEP_SEC_KEY]),
    queuedRunStaleAfterSec: resolveStaleAfterSec(processes[QUEUED_RUN_STALE_AFTER_SEC_KEY]),
  };
}

/**
 * Read the stored settings. A database error is not fatal for a background pass:
 * the defaults are the vendor behaviour, so the dispatcher keeps working.
 */
export async function loadRunDispatchSettings(db: Db): Promise<RunDispatchSettings> {
  try {
    const [row] = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .limit(1);
    return resolveRunDispatchSettings(row?.general ?? {});
  } catch {
    return { ...DEFAULT_RUN_DISPATCH_SETTINGS };
  }
}