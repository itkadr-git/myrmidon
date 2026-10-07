// Board self-deploy (myrmidon 1.7 AUTO-UPDATE-SETTINGS B): storage of the
// update policy — the `myrmidonAutoUpdate` key of instance_settings.general,
// the same pattern the deploy jobs (R5-A) and the maintenance mode (R3) use.
//
// The vendor settings service strips unknown keys, so this module reads and
// writes the raw row itself and instance-settings.ts carries the key over a
// vendor write (see preserveAutoUpdateGeneralKey and the myrmidon(R5-A/B) call
// site there).

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import { parseAutoUpdateSettings, type AutoUpdateSettings } from "./auto-update.js";

export const AUTO_UPDATE_GENERAL_KEY = "myrmidonAutoUpdate";
const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select">;

export async function readAutoUpdateDocument(db: Runner): Promise<AutoUpdateSettings> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseAutoUpdateSettings(row?.general?.[AUTO_UPDATE_GENERAL_KEY]);
}

/**
 * Read-modify-write the policy under a row lock. `change` returns the next
 * document (or null to leave it as is) and a value handed back to the caller.
 */
export async function mutateAutoUpdateDocument<T>(
  db: Db,
  change: (current: AutoUpdateSettings) => { next: AutoUpdateSettings | null; result: T },
): Promise<{ doc: AutoUpdateSettings; result: T; changed: boolean }> {
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
  return value === undefined ? {} : { [AUTO_UPDATE_GENERAL_KEY]: value };
}