// Board self-deploy (myrmidon 1.7 AUTO-UPDATE-SETTINGS B): storage of the
// update policy — the `myrmidonAutoUpdate` key of instance_settings.general,
// the same pattern the deploy jobs (R5-A) and the maintenance mode (R3) use.
//
// The vendor settings service strips unknown keys, so this module reads and
// writes the raw row itself and instance-settings.ts carries the key over a
// vendor write (see preserveAutoUpdateGeneralKey and the myrmidon(R5-A/B) call
// site there).

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@myrmidon/db";
import { parseAutoUpdateSettings, type AutoUpdateSettings } from "./auto-update.js";

export const AUTO_UPDATE_GENERAL_KEY = "myrmidonAutoUpdate";
const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select">;

/**
 * The seam the tests use, the same fields the service probes when it resolves
 * the policy. A fake store is a db-shaped object that carries the policy
 * itself, so routes and service can be exercised without a database.
 */
interface FakeAutoUpdateStore {
  readAutoUpdate?: () => Promise<AutoUpdateSettings>;
  mutateAutoUpdate?: <T>(
    change: (current: AutoUpdateSettings) => { next: AutoUpdateSettings | null; result: T },
  ) => Promise<{ doc: AutoUpdateSettings; result: T; changed: boolean }>;
}

function fakeStore(db: unknown): FakeAutoUpdateStore | null {
  const candidate = db as FakeAutoUpdateStore | null;
  if (!candidate) return null;
  return typeof candidate.readAutoUpdate === "function" || typeof candidate.mutateAutoUpdate === "function"
    ? candidate
    : null;
}

export async function readAutoUpdateDocument(db: Runner): Promise<AutoUpdateSettings> {
  const fake = fakeStore(db);
  if (fake?.readAutoUpdate) return fake.readAutoUpdate();
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  const general = row?.general as Record<string, unknown> | undefined;
  const doc = parseAutoUpdateSettings(general?.[AUTO_UPDATE_GENERAL_KEY]);
  // OPE-12123: the flat instance-general canary fields are the operator-facing
  // source.  When present they win over the nested document values (which may
  // be absent on rows written before the flat keys existed).
  if (general) {
    if (typeof general.updateCanary === "boolean") doc.updateCanary = general.updateCanary;
    if (typeof general.updateCanaryPercent === "number" && Number.isInteger(general.updateCanaryPercent)
        && general.updateCanaryPercent >= 0 && general.updateCanaryPercent <= 100) {
      doc.updateCanaryPercent = general.updateCanaryPercent;
    }
  }
  return doc;
}

/**
 * Read-modify-write the policy under a row lock. `change` returns the next
 * document (or null to leave it as is) and a value handed back to the caller.
 */
export async function mutateAutoUpdateDocument<T>(
  db: Db,
  change: (current: AutoUpdateSettings) => { next: AutoUpdateSettings | null; result: T },
): Promise<{ doc: AutoUpdateSettings; result: T; changed: boolean }> {
  const fake = fakeStore(db);
  if (fake?.mutateAutoUpdate) return fake.mutateAutoUpdate(change);
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
    const current = parseAutoUpdateSettings(row.general?.[AUTO_UPDATE_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${AUTO_UPDATE_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveAutoUpdateGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[AUTO_UPDATE_GENERAL_KEY];
  const preserved: Record<string, unknown> = value === undefined ? {} : { [AUTO_UPDATE_GENERAL_KEY]: value };
  // OPE-12123: the flat canary fields live at the top level of general, not
  // under the myrmidonAutoUpdate key, so they need their own preserve lines.
  const raw = storedGeneral as Record<string, unknown>;
  if (typeof raw.updateCanary === "boolean") preserved.updateCanary = raw.updateCanary;
  if (typeof raw.updateCanaryPercent === "number") preserved.updateCanaryPercent = raw.updateCanaryPercent;
  return preserved;
}