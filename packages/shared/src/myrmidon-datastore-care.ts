// packages/shared/src/myrmidon-datastore-care.ts
//
// myrmidon(1.6.5-DBC1): the shared shape of the datastore-care retention
// settings (DB-CARE, docs/myrmidon/changes/ope5939-dbc1-context-retention.md).
//
// The settings live under `instance_settings.general.datastoreCare.retention`
// so the UI shows one "Хранение" panel: `heartbeatRunContextDays` (DBC-1,
// this part) sits in the same block as the row-deletion day limits a sibling
// part (OPE-5011) adds later. Lenient by design: a row written by an older or
// a newer version must still parse, so every field is optional and the
// normalizers below are the only readers.

import { z } from "zod";

/** The general-settings key holding the datastore-care block. */
export const DATASTORE_CARE_SETTINGS_KEY = "datastoreCare";
/** The retention sub-block inside it. */
export const DATASTORE_CARE_RETENTION_KEY = "retention";

/** DBC-1 default: run context is compacted 7 days after the run. */
export const DEFAULT_HEARTBEAT_RUN_CONTEXT_DAYS = 7;

/** The activity action written when a compaction pass did work. */
export const DATASTORE_RETENTION_APPLIED_ACTION = "datastore.retention_applied";
/** The activity action written (throttled) when the backup gate blocks. */
export const DATASTORE_RETENTION_WAITING_FOR_BACKUP_ACTION =
  "datastore.retention_waiting_for_backup";

export const datastoreCareRetentionSettingsSchema = z
  .object({
    // Whole days after a terminal run's created_at before its context
    // snapshot is compacted; 0 disables the compaction. Absent means "use
    // the environment variable, then the default (7)" — see the module
    // server/src/myrmidon/datastore-care/retention/settings.ts.
    heartbeatRunContextDays: z.number().int().min(0).max(3650).optional(),
  })
  .passthrough();

export const datastoreCareSettingsSchema = z
  .object({
    retention: datastoreCareRetentionSettingsSchema.optional(),
  })
  .passthrough();

/**
 * Inferred straight from the zod schema (house pattern, like HostDiskSettings):
 * the `.passthrough()` index signature is what lets this block survive the
 * `contextLastRun` pass-state field the sweep persists under it (see
 * server/src/myrmidon/datastore-care/retention/settings.ts) and keeps
 * InstanceGeneralSettings assignable from the parsed defaults.
 */
export type DatastoreCareRetentionSettings = z.infer<
  typeof datastoreCareRetentionSettingsSchema
>;

export function normalizeDatastoreCareRetention(
  value: unknown,
): DatastoreCareRetentionSettings {
  const block =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  const days = block?.heartbeatRunContextDays;
  return {
    heartbeatRunContextDays:
      typeof days === "number" && Number.isInteger(days) && days >= 0 && days <= 3650
        ? days
        : undefined,
  };
}

export const patchDatastoreCareRetentionSchema = z
  .object({
    heartbeatRunContextDays: z.number().int().min(0).max(3650).optional(),
  })
  .strict();
export type DatastoreCareRetentionPatch = z.infer<typeof patchDatastoreCareRetentionSchema>;

/** The persisted state of the last compaction pass (survives restarts). */
export interface DatastoreCareRetentionBackupGateState {
  /** The directory the gate inspected. */
  backupDir: string;
  /** The filename prefix the gate matched (empty = any accepted name). */
  prefix: string;
  /** Newest matching backup mtime (ISO), or null when none/readable. */
  newestBackupAt: string | null;
  /** Base name of the newest matching backup file, when one exists. */
  newestBackupFile: string | null;
  /** Its size in bytes. */
  newestBackupSizeBytes: number | null;
  /** False when the dir could not be listed at all. */
  dirReadable: boolean;
  /** Up to 5 backup-looking files that did not match the prefix. */
  candidates: string[];
}

export interface DatastoreCareRetentionLastRun {
  /** ISO timestamp of the last pass, null before the first one. */
  lastRunAt: string | null;
  /** True when the last pass deleted nothing because the backup gate blocked. */
  waitingForBackup: boolean;
  /** ISO mtime of the newest fresh-enough backup seen by the gate. */
  backupCheckedAt: string | null;
  /** The gate verdict of the last pass (what was checked, what was found). */
  backupGate?: DatastoreCareRetentionBackupGateState;
  /** Terminal runs whose context was compacted in the last pass. */
  lastCompacted: number;
  /** Bytes the last pass shrank context_snapshot values by (lower bound). */
  lastFreedBytes: number;
  /** Sum over all passes since the key was first written. */
  compactedTotal: number;
  freedBytesTotal: number;
}

export function emptyDatastoreCareRetentionLastRun(): DatastoreCareRetentionLastRun {
  return {
    lastRunAt: null,
    waitingForBackup: false,
    backupCheckedAt: null,
    lastCompacted: 0,
    lastFreedBytes: 0,
    compactedTotal: 0,
    freedBytesTotal: 0,
  };
}

export function normalizeDatastoreCareRetentionLastRun(
  value: unknown,
): DatastoreCareRetentionLastRun {
  const empty = emptyDatastoreCareRetentionLastRun();
  if (typeof value !== "object" || value === null) return empty;
  const raw = value as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
  const iso = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const gateRaw =
    typeof raw.backupGate === "object" && raw.backupGate !== null
      ? (raw.backupGate as Record<string, unknown>)
      : null;
  const backupGate: DatastoreCareRetentionBackupGateState | undefined = gateRaw
    ? {
        backupDir: typeof gateRaw.backupDir === "string" ? gateRaw.backupDir : "",
        prefix: typeof gateRaw.prefix === "string" ? gateRaw.prefix : "",
        newestBackupAt: iso(gateRaw.newestBackupAt),
        newestBackupFile: iso(gateRaw.newestBackupFile),
        newestBackupSizeBytes:
          typeof gateRaw.newestBackupSizeBytes === "number" &&
          Number.isFinite(gateRaw.newestBackupSizeBytes)
            ? gateRaw.newestBackupSizeBytes
            : null,
        dirReadable: gateRaw.dirReadable !== false,
        candidates: Array.isArray(gateRaw.candidates)
          ? gateRaw.candidates.filter((v): v is string => typeof v === "string").slice(0, 5)
          : [],
      }
    : undefined;
  return {
    lastRunAt: iso(raw.lastRunAt),
    waitingForBackup: raw.waitingForBackup === true,
    backupCheckedAt: iso(raw.backupCheckedAt),
    ...(backupGate ? { backupGate } : {}),
    lastCompacted: num(raw.lastCompacted, 0),
    lastFreedBytes: num(raw.lastFreedBytes, 0),
    compactedTotal: num(raw.compactedTotal, 0),
    freedBytesTotal: num(raw.freedBytesTotal, 0),
  };
}
