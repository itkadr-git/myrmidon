// server/src/myrmidon/behavior-settings/store.ts
//
// myrmidon(1.7, SETTINGS-TO-UI A): raw-row storage for behavior settings under
// our own keys of `instance_settings.general` — the same rule every myrmidon
// track uses (telegram-notify, autonomy): the vendor settings service strips
// unknown keys, so this module reads and writes the raw row itself and the
// `preserveBehaviorSettingsGeneralKey` seam (wired in the service production
// path) keeps the key across vendor general writes. No migration: an old image
// keeps working on the new schema.
//
// - Instance-scoped settings: `general.behaviorSettings` (a flat key → value
//   map), the same shape runLimits uses.
// - Company-scoped settings: `general.behaviorSettingsByCompany`, a
//   companyId → (key → value) map, the same shape telegram-notify uses for
//   per-company state.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";

/** The storage key for instance-scoped behavior settings. */
export const BEHAVIOR_SETTINGS_GENERAL_KEY = "behaviorSettings";
/** The storage key for the company-keyed map of behavior settings. */
export const BEHAVIOR_SETTINGS_BY_COMPANY_GENERAL_KEY = "behaviorSettingsByCompany";

const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select" | "insert" | "update">;

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** Read the stored instance-scoped settings (raw, unvalidated). */
export async function readInstanceBehaviorSettings(
  db: Runner,
): Promise<Record<string, unknown> | undefined> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  const stored = asRecord(row?.general?.[BEHAVIOR_SETTINGS_GENERAL_KEY]);
  return stored === null ? undefined : { ...stored };
}

/** Read the stored company-scoped settings for one company (raw, unvalidated). */
export async function readCompanyBehaviorSettings(
  db: Runner,
  companyId: string,
): Promise<Record<string, unknown> | undefined> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  const area = asRecord(row?.general?.[BEHAVIOR_SETTINGS_BY_COMPANY_GENERAL_KEY]);
  const stored = area ? asRecord(area[companyId]) : null;
  return stored === null ? undefined : { ...stored };
}

/** Read-modify-write under a row lock, scoped to the instance-level key. */
export async function mutateInstanceBehaviorSettings<T>(
  db: Db,
  change: (current: Record<string, unknown> | undefined) => { next: Record<string, unknown>; result: T },
): Promise<T> {
  return db.transaction(async (tx) => {
    await ensureRow(tx);
    const row = await lockRow(tx);
    const stored = asRecord(row.general?.[BEHAVIOR_SETTINGS_GENERAL_KEY]);
    const { next, result } = change(stored === null ? undefined : { ...stored });
    await writeAreaKey(tx, row.id, BEHAVIOR_SETTINGS_GENERAL_KEY, next);
    return result;
  });
}

/** Read-modify-write under a row lock, scoped to one company inside our area. */
export async function mutateCompanyBehaviorSettings<T>(
  db: Db,
  companyId: string,
  change: (current: Record<string, unknown> | undefined) => { next: Record<string, unknown>; result: T },
): Promise<T> {
  return db.transaction(async (tx) => {
    await ensureRow(tx);
    const row = await lockRow(tx);
    const area =
      asRecord(row.general?.[BEHAVIOR_SETTINGS_BY_COMPANY_GENERAL_KEY]) ?? {};
    const stored = asRecord(area[companyId]);
    const { next, result } = change(stored === null ? undefined : { ...stored });
    area[companyId] = next;
    await writeAreaKey(
      tx,
      row.id,
      BEHAVIOR_SETTINGS_BY_COMPANY_GENERAL_KEY,
      area as Record<string, unknown>,
    );
    return result;
  });
}

/** Keep our keys across vendor writes of instance_settings.general. */
export function preserveBehaviorSettingsGeneralKeys(
  storedGeneral: unknown,
): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const record = storedGeneral as Record<string, unknown>;
  const preserved: Record<string, unknown> = {};
  if (record[BEHAVIOR_SETTINGS_GENERAL_KEY] !== undefined) {
    preserved[BEHAVIOR_SETTINGS_GENERAL_KEY] = record[BEHAVIOR_SETTINGS_GENERAL_KEY];
  }
  if (record[BEHAVIOR_SETTINGS_BY_COMPANY_GENERAL_KEY] !== undefined) {
    preserved[BEHAVIOR_SETTINGS_BY_COMPANY_GENERAL_KEY] =
      record[BEHAVIOR_SETTINGS_BY_COMPANY_GENERAL_KEY];
  }
  return preserved;
}

async function ensureRow(tx: Pick<Db, "insert">): Promise<void> {
  await tx
    .insert(instanceSettings)
    .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
    .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
}

async function lockRow(tx: Pick<Db, "select">): Promise<{ id: string; general: Record<string, unknown> }> {
  const row = await tx
    .select({ id: instanceSettings.id, general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .for("update")
    .then((rows) => rows[0]!);
  return { id: row.id, general: (row.general ?? {}) as Record<string, unknown> };
}

async function writeAreaKey(
  tx: Pick<Db, "update">,
  rowId: string,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  await tx
    .update(instanceSettings)
    .set({
      general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${key}}`}::text[], ${JSON.stringify(value)}::jsonb, true)`,
    })
    .where(eq(instanceSettings.id, rowId));
}
