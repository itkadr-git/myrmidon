// server/src/myrmidon/data-retention/settings.ts
//
// myrmidon(1.6.5-DB-RETENTION): read and write
// `instance_settings.general.datastoreCare.retention` (the project §3.6
// "Хранение" panel — one datastore-care object, OPE-5939/DBC-1).
//
// The stored value is the single truth (no env fallback — retention is a
// policy choice, not a deployment knob); an absent or malformed row means the
// defaults (90/0/180). The sweep state rides the same object under `lastRun`,
// so the status endpoint stays one cheap settings read. This module is the
// database half: read the raw row, normalize it, write the canonical object
// back. Sibling sub-keys of `datastoreCare` (other DB-care features) survive
// every write untouched. The same shape the wip-limit and autonomy settings
// use.

import {
  DATA_RETENTION_SETTINGS_KEY,
  DATA_RETENTION_SETTINGS_SUBKEY,
  emptyDataRetentionLastRun,
  normalizeDataRetentionLastRun,
  normalizeDataRetentionSettings,
  type DataRetentionLastRun,
  type DataRetentionSettings,
  type DataRetentionSettingsPatch,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export type DataRetentionSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

/** The stored `datastoreCare` object, or undefined when absent. */
function storedDatastoreCare(
  general: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const value = general[DATA_RETENTION_SETTINGS_KEY];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The raw stored retention object (settings + sweep state), or undefined. */
function storedDataRetention(
  general: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const value = storedDatastoreCare(general)?.[DATA_RETENTION_SETTINGS_SUBKEY];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Write the retention object, keeping the sibling datastore-care sub-keys. */
async function writeRetention(
  settings: DataRetentionSettingsService,
  retention: Record<string, unknown>,
): Promise<void> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  const care = storedDatastoreCare(general) ?? {};
  // the merge object is wider than the typed `datastoreCare` field (sibling
  // sub-keys ride along), so build it as a plain record and pass it as-is —
  // the settings service validates the shape on its side
  const nextCare: Record<string, unknown> = {
    ...care,
    [DATA_RETENTION_SETTINGS_SUBKEY]: retention,
  };
  await settings.updateGeneral({
    [DATA_RETENTION_SETTINGS_KEY]: nextCare,
  } as Parameters<DataRetentionSettingsService["updateGeneral"]>[0]);
}

/** Read the retention settings (or the defaults when absent). */
export async function readDataRetentionSettings(
  settings: DataRetentionSettingsService,
): Promise<DataRetentionSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizeDataRetentionSettings(
    storedDatastoreCare(general)?.[DATA_RETENTION_SETTINGS_SUBKEY],
  );
}

/** Read the persisted sweep state (or the empty state when absent). */
export async function readDataRetentionLastRun(
  settings: DataRetentionSettingsService,
): Promise<DataRetentionLastRun> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  const stored = storedDataRetention(general);
  return stored ? normalizeDataRetentionLastRun(stored.lastRun) : emptyDataRetentionLastRun();
}

/**
 * Validate and store a partial settings patch. The sweep state (`lastRun`)
 * already stored under the key survives: the write merges the patch over the
 * current stored object instead of replacing it.
 */
export async function writeDataRetentionSettings(
  settings: DataRetentionSettingsService,
  patch: DataRetentionSettingsPatch,
): Promise<DataRetentionSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  const stored = storedDataRetention(general);
  const current = normalizeDataRetentionSettings(stored);
  const next: DataRetentionSettings = {
    heartbeatRunsDays: patch.heartbeatRunsDays ?? current.heartbeatRunsDays,
    activityLogDays: patch.activityLogDays ?? current.activityLogDays,
    accessAuditDays: patch.accessAuditDays ?? current.accessAuditDays,
  };
  // merge over the stored object: `lastRun` and the sibling DBC-1 keys
  // (`heartbeatRunContextDays`, `contextLastRun`) are not ours to drop
  await writeRetention(settings, { ...(stored ?? {}), ...next });
  return next;
}

/**
 * Persist the sweep state under `lastRun`, keeping the stored day values (or
 * the defaults when the row holds nothing usable yet).
 */
export async function writeDataRetentionLastRun(
  settings: DataRetentionSettingsService,
  lastRun: DataRetentionLastRun,
): Promise<void> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  const stored = storedDataRetention(general);
  const current = normalizeDataRetentionSettings(stored);
  await writeRetention(settings, {
    ...(stored ?? {}),
    ...current,
    lastRun: { ...lastRun } as Record<string, unknown>,
  });
}

/**
 * Keep the stored key across vendor writes of `instance_settings.general` —
 * the same contract every other myrmidon general key follows.
 */
export function preserveDataRetentionGeneralKey(
  storedGeneral: unknown,
): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[DATA_RETENTION_SETTINGS_KEY];
  return value === undefined ? {} : { [DATA_RETENTION_SETTINGS_KEY]: value };
}
