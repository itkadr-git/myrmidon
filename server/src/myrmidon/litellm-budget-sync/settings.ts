// server/src/myrmidon/litellm-budget-sync/settings.ts
//
// myrmidon(1.7-BUDGET-CONFIG-C): read and write the per-company settings
// documents `instance_settings.general.myrmidonBudgetProjectionCompanies[companyId]`
// — the no-migration JSON pattern the STT store uses (row-locked
// read-modify-write, the vendor write of `general` preserves our key through
// the preserve hook in instance-settings.ts).
//
// The sweep interval: the stored document carries the company's choice
// (`sweepIntervalSec`, null = the default 30 s); ONE env variable is a forced
// override (never a default source); every response names where the value
// came from ("settings" / "env" / "default").

import type { Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { instanceSettings } from "@paperclipai/db";
import {
  BUDGET_PROJECTION_COMPANIES_KEY,
  budgetProjectionSettingsSchema,
  normalizeBudgetProjectionSettings,
  type BudgetProjectionSettingSource,
  type BudgetProjectionStoredSettings,
} from "@paperclipai/shared";

/** Forced override of the sweep interval (seconds); env is never the default. */
export const BUDGET_PROJECTION_SWEEP_INTERVAL_ENV = "MYRMIDON_LITELLM_BUDGET_SYNC_INTERVAL_SEC";

export const DEFAULT_BUDGET_PROJECTION_SWEEP_INTERVAL_SEC = 30;
const MIN_BUDGET_PROJECTION_SWEEP_INTERVAL_SEC = 10;
const MAX_BUDGET_PROJECTION_SWEEP_INTERVAL_SEC = 3600;
const SINGLETON_KEY = "default";

/** The resolved runtime settings the sweep and routes share. */
export interface ResolvedBudgetProjectionSettings {
  settings: BudgetProjectionStoredSettings;
  /** The sweep interval actually in force. */
  sweepIntervalSec: number;
  /** Where the sweep interval came from: the env override, the stored doc, or the default. */
  sweepIntervalSource: BudgetProjectionSettingSource;
}

type GeneralRecord = Record<string, unknown>;

function asGeneral(value: unknown): GeneralRecord {
  return typeof value === "object" && value !== null ? (value as GeneralRecord) : {};
}

function normalizeCompanyId(companyId: string): string {
  return companyId.trim().toLowerCase();
}

/** Reads the stored document of one company; the implicit default when absent. */
export async function readBudgetProjectionSettings(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<BudgetProjectionStoredSettings> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  const companies = asGeneral(row?.general)[BUDGET_PROJECTION_COMPANIES_KEY];
  const stored = typeof companies === "object" && companies !== null
    ? (companies as GeneralRecord)[normalizeCompanyId(companyId)]
    : undefined;
  return normalizeBudgetProjectionSettings(stored);
}

/** Read-modify-write one company's document under a row lock (the STT shape). */
export async function mutateBudgetProjectionDocument<T>(
  db: Db,
  companyId: string,
  change: (current: BudgetProjectionStoredSettings) => { next: BudgetProjectionStoredSettings; result: T },
): Promise<{ doc: BudgetProjectionStoredSettings; result: T; changed: boolean }> {
  const key = normalizeCompanyId(companyId);
  return db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    const companies = readBudgetProjectionCompaniesMap(row.general);
    const current = normalizeBudgetProjectionSettings(companies[key]);
    const { next, result } = change(current);
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    if (changed) {
      const companiesNext = { ...companies, [key]: next };
      await tx
        .update(instanceSettings)
        .set({
          general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${JSON.stringify([
            BUDGET_PROJECTION_COMPANIES_KEY,
          ])}::jsonb[], ${JSON.stringify(JSON.stringify(companiesNext))}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(eq(instanceSettings.id, row.id));
    }
    return { doc: next, result, changed };
  });
}

/** The whole stored companies map, for the preserve hook. */
export function readBudgetProjectionCompaniesMap(general: unknown): Record<string, unknown> {
  const value = asGeneral(general)[BUDGET_PROJECTION_COMPANIES_KEY];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveBudgetProjectionGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  const value = readBudgetProjectionCompaniesMap(storedGeneral);
  return Object.keys(value).length > 0 ? { [BUDGET_PROJECTION_COMPANIES_KEY]: value } : {};
}

/**
 * Resolve the effective runtime settings for one company: the stored document
 * plus the sweep interval. The env variable is a FORCED override only; the
 * stored document is the source the UI writes; the default (30 s) sits
 * inside the ticket's ≤ 60 s acceptance window.
 */
export async function resolveBudgetProjectionRuntime(
  db: Pick<Db, "select">,
  companyId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedBudgetProjectionSettings> {
  const settings = await readBudgetProjectionSettings(db, companyId);
  let sweepIntervalSec = DEFAULT_BUDGET_PROJECTION_SWEEP_INTERVAL_SEC;
  let sweepIntervalSource: BudgetProjectionSettingSource = "default";
  if (typeof settings.sweepIntervalSec === "number" && Number.isInteger(settings.sweepIntervalSec)) {
    sweepIntervalSec = settings.sweepIntervalSec;
    sweepIntervalSource = "settings";
  }
  const rawEnv = env[BUDGET_PROJECTION_SWEEP_INTERVAL_ENV]?.trim();
  if (rawEnv) {
    const value = Number(rawEnv);
    if (Number.isInteger(value)) {
      sweepIntervalSec = clampSweepInterval(value);
      sweepIntervalSource = "env";
    }
  }
  return { settings, sweepIntervalSec, sweepIntervalSource };
}

export function clampSweepInterval(value: number): number {
  return Math.min(
    Math.max(value, MIN_BUDGET_PROJECTION_SWEEP_INTERVAL_SEC),
    MAX_BUDGET_PROJECTION_SWEEP_INTERVAL_SEC,
  );
}

/** Validate a full settings PUT (the routes use this). */
export function parseBudgetProjectionSettings(input: unknown): BudgetProjectionStoredSettings {
  const parsed = budgetProjectionSettingsSchema.parse(input);
  // The PUT body never carries `projected`; the mutation keeps the stored one.
  return { ...parsed, projected: {} };
}
