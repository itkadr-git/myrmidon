import type { Db } from "@paperclipai/db";
import {
  ALERT_RECOVERY_JOURNAL_KEY,
  ALERT_RECOVERY_SETTINGS_KEY,
  coerceAlertRecoveryRecords,
  resolveAlertRecoverySettings,
  type AlertRecoveryRecord,
  type AlertRecoverySettings,
  type ResolvedAlertRecoverySettings,
} from "@paperclipai/shared";
import { instanceSettingsService } from "../../../services/index.js";

/**
 * Where the alert-recovery state lives (myrmidon 1.6.6 MONITORING, part D).
 *
 * Two general-settings keys, no migration:
 *
 * - `instance_settings.general.alertRecovery` holds the knobs. They resolve
 *   through the stored value → environment → default chain, so the row is
 *   optional and a hand-edited value that does not validate reads as absent.
 * - `instance_settings.general.alertRecoveryJournal` holds one record per alert
 *   identity — the task the alert opened and how long it has been resolved.
 *   Stored passthrough, like `swarmClaimJournal`; a broken row is dropped on
 *   read. The row is instance-wide, so it keeps the records of every company in
 *   one list: every read filters by company, and every write replaces only that
 *   company's records.
 *
 * The store is the only place that knows the storage shape — the service works
 * with resolved settings and records and never touches the settings row.
 */

export interface AlertRecoveryGeneralSettings {
  alertRecovery?: unknown;
  alertRecoveryJournal?: unknown;
}

/** The slice of the instance settings service this module uses. */
export interface AlertRecoverySettingsPort {
  getGeneral(): Promise<AlertRecoveryGeneralSettings>;
  updateGeneral(patch: Record<string, unknown>): Promise<unknown>;
}

export interface AlertRecoveryStore {
  /** The knobs in force with the layer each one came from. */
  readResolved(): Promise<ResolvedAlertRecoverySettings>;
  /** Write the knobs back, fully resolved. */
  writeSettings(settings: AlertRecoverySettings): Promise<void>;
  /** Records of one company, or of every company when none is named. */
  readRecords(companyId?: string): Promise<AlertRecoveryRecord[]>;
  /** Replace the records of one company, keeping the records of the others. */
  writeRecords(companyId: string, records: readonly AlertRecoveryRecord[]): Promise<void>;
}

/** The general settings row, whichever way the service hands it over. */
function generalRow(raw: unknown): AlertRecoveryGeneralSettings {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const data = value.data;
  return (data && typeof data === "object" && !Array.isArray(data) ? data : value) as AlertRecoveryGeneralSettings;
}

export function createAlertRecoveryStore(input: {
  settings: AlertRecoverySettingsPort;
  env?: Record<string, string | undefined>;
}): AlertRecoveryStore {
  const env = input.env ?? process.env;

  async function readGeneral(): Promise<AlertRecoveryGeneralSettings> {
    return generalRow(await input.settings.getGeneral());
  }

  return {
    readResolved: async () => {
      const general = await readGeneral();
      return resolveAlertRecoverySettings({ stored: general[ALERT_RECOVERY_SETTINGS_KEY], env });
    },

    writeSettings: async (settings) => {
      await input.settings.updateGeneral({ [ALERT_RECOVERY_SETTINGS_KEY]: settings });
    },

    readRecords: async (companyId) => {
      const general = await readGeneral();
      const records = coerceAlertRecoveryRecords(general[ALERT_RECOVERY_JOURNAL_KEY]);
      return companyId ? records.filter((record) => record.companyId === companyId) : records;
    },

    writeRecords: async (companyId, records) => {
      const general = await readGeneral();
      const others = coerceAlertRecoveryRecords(general[ALERT_RECOVERY_JOURNAL_KEY]).filter(
        (record) => record.companyId !== companyId,
      );
      await input.settings.updateGeneral({
        [ALERT_RECOVERY_JOURNAL_KEY]: [...others, ...records],
      });
    },
  };
}

/** The store over the real instance settings service of one database handle. */
export function createDbAlertRecoveryStore(db: Db, env?: Record<string, string | undefined>): AlertRecoveryStore {
  return createAlertRecoveryStore({
    settings: instanceSettingsService(db) as unknown as AlertRecoverySettingsPort,
    env,
  });
}