// server/src/myrmidon/datastore-care/retention/settings.ts
//
// myrmidon(1.6.5-DBC1): read/write of `general.datastoreCare.retention`.
//
// The stored value is the truth; when the block (or the day key) is absent,
// the environment variable PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS
// applies, then the default (7 days). The sweep re-reads the value at the top
// of every pass, so a settings change needs no restart. The pass state rides
// the same block under `contextLastRun`, the same shape the data-retention module
// uses, so the panel reads one cheap settings object.

import {
  DATASTORE_CARE_RETENTION_KEY,
  DATASTORE_CARE_SETTINGS_KEY,
  DEFAULT_HEARTBEAT_RUN_CONTEXT_DAYS,
  normalizeDatastoreCareRetention,
  normalizeDatastoreCareRetentionLastRun,
  type DatastoreCareRetentionLastRun,
  type DatastoreCareRetentionPatch,
  type PatchInstanceGeneralSettings,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../../services/instance-settings.js";

export type DatastoreCareSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral" | "listCompanyIds"
>;

/** The environment override for the compaction window, in whole days. */
export const HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS_ENV =
  "PAPERCLIP_HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS";

export interface ResolvedRetentionSettings {
  /** Whole days after created_at before a terminal run's context compacts. */
  heartbeatRunContextDays: number;
  /** Where the value came from: the stored settings block or the default. */
  source: "settings" | "env" | "default";
}

function envRetentionDays(env: Record<string, string | undefined>): number | undefined {
  const raw = env[HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS_ENV]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) return undefined;
  return parsed;
}

/**
 * Resolve the compaction window: stored settings, then the environment
 * variable, then the default (7). 0 disables the compaction.
 */
export function resolveRetentionSettings(
  general: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): ResolvedRetentionSettings {
  const care = general[DATASTORE_CARE_SETTINGS_KEY];
  const block =
    typeof care === "object" && care !== null
      ? (care as Record<string, unknown>)[DATASTORE_CARE_RETENTION_KEY]
      : undefined;
  const stored = normalizeDatastoreCareRetention(block);
  if (stored.heartbeatRunContextDays !== undefined) {
    return { heartbeatRunContextDays: stored.heartbeatRunContextDays, source: "settings" };
  }
  const fromEnv = envRetentionDays(env);
  if (fromEnv !== undefined) {
    return { heartbeatRunContextDays: fromEnv, source: "env" };
  }
  return { heartbeatRunContextDays: DEFAULT_HEARTBEAT_RUN_CONTEXT_DAYS, source: "default" };
}

/** Read the resolved settings for one pass. */
export async function readRetentionSettings(
  settings: DatastoreCareSettingsService,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedRetentionSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return resolveRetentionSettings(general, env);
}

function storedCareRetention(general: Record<string, unknown>): Record<string, unknown> | undefined {
  const care = general[DATASTORE_CARE_SETTINGS_KEY];
  if (typeof care !== "object" || care === null) return undefined;
  const block = (care as Record<string, unknown>)[DATASTORE_CARE_RETENTION_KEY];
  return typeof block === "object" && block !== null ? (block as Record<string, unknown>) : undefined;
}

/** Read the persisted pass state (or the empty state when absent). */
export async function readRetentionLastRun(
  settings: DatastoreCareSettingsService,
): Promise<DatastoreCareRetentionLastRun> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  const stored = storedCareRetention(general);
  return stored ? normalizeDatastoreCareRetentionLastRun(stored.contextLastRun) : normalizeDatastoreCareRetentionLastRun(undefined);
}

/** Write a partial patch; the pass state (`contextLastRun`) under the block survives. */
export async function writeRetentionSettings(
  settings: DatastoreCareSettingsService,
  patch: DatastoreCareRetentionPatch,
): Promise<DatastoreCareRetentionPatch> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  const stored = storedCareRetention(general);
  const next: Record<string, unknown> = { ...(stored ?? {}) };
  if (patch.heartbeatRunContextDays !== undefined) {
    next.heartbeatRunContextDays = patch.heartbeatRunContextDays;
  } else {
    delete next.heartbeatRunContextDays;
  }
  const care = general[DATASTORE_CARE_SETTINGS_KEY];
  const careBlock = typeof care === "object" && care !== null ? { ...(care as Record<string, unknown>) } : {};
  if (Object.keys(next).length > 0) {
    careBlock[DATASTORE_CARE_RETENTION_KEY] = next;
  } else {
    delete careBlock[DATASTORE_CARE_RETENTION_KEY];
  }
  const generalPatch: PatchInstanceGeneralSettings = { datastoreCare: careBlock as never };
  await settings.updateGeneral(generalPatch);
  return patch;
}

/** Persist the pass state under `contextLastRun`, keeping the stored day values. */
export async function writeRetentionLastRun(
  settings: DatastoreCareSettingsService,
  lastRun: DatastoreCareRetentionLastRun,
): Promise<void> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  const stored = storedCareRetention(general);
  const care = general[DATASTORE_CARE_SETTINGS_KEY];
  const careBlock: Record<string, unknown> =
    typeof care === "object" && care !== null ? { ...(care as Record<string, unknown>) } : {};
  careBlock[DATASTORE_CARE_RETENTION_KEY] = { ...(stored ?? {}), contextLastRun: { ...lastRun } };
  const lastRunPatch: PatchInstanceGeneralSettings = { datastoreCare: careBlock as never };
  await settings.updateGeneral(lastRunPatch);
}

/**
 * Keep `general.datastoreCare` across vendor writes of
 * `instance_settings.general` — the same contract every other myrmidon
 * general key follows.
 */
export function preserveDatastoreCareGeneralKey(
  storedGeneral: unknown,
): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[DATASTORE_CARE_SETTINGS_KEY];
  return value === undefined ? {} : { [DATASTORE_CARE_SETTINGS_KEY]: value };
}
