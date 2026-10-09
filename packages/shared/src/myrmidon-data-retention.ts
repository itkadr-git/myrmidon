// packages/shared/src/myrmidon-data-retention.ts
//
// myrmidon(1.6.5-DB-RETENTION): the shared contract of the database retention
// sweep (part P1 — the server core: settings, sweep, backup gate).
//
// One object is stored in
// `instance_settings.general.datastoreCare.retention`:
//
//   - `heartbeatRunsDays` — how long finished heartbeat runs (and their run
//     events) are kept (default 90);
//   - `activityLogDays` — how long activity-log rows are kept (default 0 —
//     the activity log is the audit trail and is kept forever by default);
//   - `accessAuditDays` — how long tool-access audit events and secret access
//     events are kept (default 180).
//
// Each value is a whole number of days >= 0; `0` means "keep forever". The
// stored value is the single truth — there is no env fallback (retention is a
// policy choice, not a deployment knob); an absent row reads as the defaults
// (90/0/180). The sweep re-reads the settings at the top of every pass, so a
// PATCH applies on the next pass without a restart.
//
// The sweep state persists under the same key in a `lastRun` sub-object, so
// the status endpoint stays one cheap settings read. `lastRun` rides the
// PATCH schema as an optional passthrough so a full-GET echo cannot drop the
// recorded sweep state, and the general-settings normalizer re-validates it
// on every write.

import { z } from "zod";

/** The `instance_settings.general.datastoreCare` sub-key this feature stores
 * its settings under: `general.datastoreCare.retention` (the project §3.6
 * "Хранение" panel, one datastore-care object for every DB-care feature —
 * OPE-5939/DBC-1). */
export const DATA_RETENTION_SETTINGS_KEY = "datastoreCare";
/** The sub-key inside `datastoreCare` the retention sweep owns. */
export const DATA_RETENTION_SETTINGS_SUBKEY = "retention";

/** Built-in default for heartbeat runs and their run events: three months. */
export const DATA_RETENTION_DEFAULT_DAYS = 90;

/** Built-in default for the tool/secret access audit: six months. */
export const DATA_RETENTION_ACCESS_AUDIT_DEFAULT_DAYS = 180;

/** A retention value: whole days >= 0; 0 means "keep forever". */
const retentionDaysSchema = z.number().int().min(0);

export const DATA_RETENTION_SETTING_KEYS = [
  "heartbeatRunsDays",
  "activityLogDays",
  "accessAuditDays",
] as const;

export type DataRetentionSettingKey = (typeof DATA_RETENTION_SETTING_KEYS)[number];

/** Where the effective value came from: the stored row, or the built-in default. */
export type DataRetentionSource = "settings" | "default";

/** The canonical stored shape of `instance_settings.general.datastoreCare.retention`. */
export const dataRetentionSettingsSchema = z
  .object({
    heartbeatRunsDays: retentionDaysSchema,
    activityLogDays: retentionDaysSchema,
    accessAuditDays: retentionDaysSchema,
  })
  .strict();

export type DataRetentionSettings = z.infer<typeof dataRetentionSettingsSchema>;

/**
 * Body of `PATCH /api/myrmidon/data-retention` — a partial update of the
 * three day values. `lastRun` is accepted as a passthrough so a full-GET echo
 * of the view does not drop the recorded sweep state on write.
 */
export const patchDataRetentionSettingsSchema = z
  .object({
    heartbeatRunsDays: retentionDaysSchema.optional(),
    activityLogDays: retentionDaysSchema.optional(),
    accessAuditDays: retentionDaysSchema.optional(),
    // myrmidon(1.6.5-F14B): "the machine is backed up outside" mode of the
    // backup gate (the same stored key the context compaction gate reads).
    externalMachineBackup: z.boolean().optional(),
    lastRun: z.unknown().optional(),
  })
  .strict();

export type DataRetentionSettingsPatch = z.infer<typeof patchDataRetentionSettingsSchema>;

/** The defaults every absent value falls back to. */
export const DATA_RETENTION_DEFAULT_SETTINGS: DataRetentionSettings = {
  heartbeatRunsDays: DATA_RETENTION_DEFAULT_DAYS,
  activityLogDays: 0,
  accessAuditDays: DATA_RETENTION_ACCESS_AUDIT_DEFAULT_DAYS,
};

/**
 * The stored object also carries the sweep state (`lastRun`) and the sibling
 * keys of the same block (DBC-1 `heartbeatRunContextDays`, `contextLastRun`,
 * `contextCompactMaxBatches`, F14B `externalMachineBackup`); the settings
 * schema is strict, so only the three retention keys are handed to the parse
 * (the rest is validated by its own normalizers).
 */
function pickDataRetentionKeys(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const source = raw as Record<string, unknown>;
  return Object.fromEntries(
    DATA_RETENTION_SETTING_KEYS.filter((key) => key in source).map((key) => [key, source[key]]),
  );
}

/** The settings as stored, or the defaults when absent/invalid. */
export function normalizeDataRetentionSettings(raw: unknown): DataRetentionSettings {
  const peeled = pickDataRetentionKeys(raw);
  const parsed = dataRetentionSettingsSchema.safeParse(peeled);
  return {
    heartbeatRunsDays: parsed.success
      ? parsed.data.heartbeatRunsDays
      : DATA_RETENTION_DEFAULT_DAYS,
    activityLogDays: parsed.success ? parsed.data.activityLogDays : 0,
    accessAuditDays: parsed.success
      ? parsed.data.accessAuditDays
      : DATA_RETENTION_ACCESS_AUDIT_DEFAULT_DAYS,
  };
}

/** Per-key provenance of the effective values: stored row or built-in default. */
export function dataRetentionSources(
  raw: unknown,
): Record<DataRetentionSettingKey, DataRetentionSource> {
  const peeled = pickDataRetentionKeys(raw);
  const parsed = dataRetentionSettingsSchema.safeParse(peeled);
  const stored = parsed.success;
  return {
    heartbeatRunsDays: stored ? "settings" : "default",
    activityLogDays: stored ? "settings" : "default",
    accessAuditDays: stored ? "settings" : "default",
  };
}

/** Per-table sweep counters, as the status view reports them. */
export interface DataRetentionTableStatus {
  /** Rows deleted across all sweeps since the counters started. */
  deletedTotal: number;
  /** Rows deleted by the last completed sweep pass. */
  lastDeleted: number;
  /**
   * Freed-bytes estimate of the last pass: the sum of `pg_column_size(id)`
   * over the rows the pass deleted (a lower bound — indexes, TOAST and the
   * payload columns are not counted; the actual table size settles after
   * autovacuum).
   */
  lastFreedBytes: number;
}

/** The persisted sweep state (`instance_settings.general.datastoreCare.retention.lastRun`). */
export interface DataRetentionLastRun {
  lastRunAt: string | null;
  waitingForBackup: boolean;
  backupCheckedAt: string | null;
  freedBytesTotal: number;
  perTable: Record<"runs" | "activity" | "access", DataRetentionTableStatus>;
}

const tableStatusSchema = z.object({
  deletedTotal: z.number().int().min(0),
  lastDeleted: z.number().int().min(0),
  lastFreedBytes: z.number().min(0),
});

const lastRunSchema = z.object({
  lastRunAt: z.string().nullable(),
  waitingForBackup: z.boolean(),
  backupCheckedAt: z.string().nullable(),
  freedBytesTotal: z.number().min(0),
  perTable: z.object({
    runs: tableStatusSchema,
    activity: tableStatusSchema,
    access: tableStatusSchema,
  }),
});

/** The empty sweep state: never ran, not waiting, nothing deleted. */
export function emptyDataRetentionLastRun(): DataRetentionLastRun {
  return {
    lastRunAt: null,
    waitingForBackup: false,
    backupCheckedAt: null,
    freedBytesTotal: 0,
    perTable: {
      runs: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
      activity: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
      access: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
    },
  };
}

/** The stored sweep state, or the empty state when absent/invalid. */
export function normalizeDataRetentionLastRun(raw: unknown): DataRetentionLastRun {
  const empty = emptyDataRetentionLastRun();
  if (typeof raw !== "object" || raw === null) return empty;
  const parsed = lastRunSchema.safeParse(raw);
  if (!parsed.success) return empty;
  return parsed.data;
}

/** Response of `GET /api/myrmidon/data-retention`. */
export interface DataRetentionView {
  settings: DataRetentionSettings;
  /**
   * myrmidon(1.6.5-F14B): true when the backup gate is in "external machine
   * backup" mode — no local dump is waited for.
   */
  externalMachineBackup: boolean;
  sources: Record<DataRetentionSettingKey, DataRetentionSource>;
  status: DataRetentionLastRun;
}

/** Activity action of a settings change written through the route. */
export const DATA_RETENTION_UPDATED_ACTION = "instance.data_retention.updated";

/**
 * Activity action the sweep writes (throttled, at most once per hour) while
 * the backup gate holds: no fresh verified backup, so no deletes this pass.
 */
export const DATA_RETENTION_WAITING_FOR_BACKUP_ACTION = "data.retention_waiting_for_backup";

/** The `data.retention_sweep_throttled` activity action — one line per group
 * whose batch hit the statement timeout (operator review
 * dbcare-review-20261008: the timeout is journaled, not swallowed). */
export const DATA_RETENTION_SWEEP_THROTTLED_ACTION = "data.retention_sweep_throttled";

