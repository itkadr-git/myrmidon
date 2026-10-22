// server/src/myrmidon/bot-containers/bot-image-rollout-store.ts
//
// myrmidon(BOT-ROLLOUT): storage of the release bot-image rollout settings —
// the `myrmidonBotImageRollout` key of instance_settings.general, the same
// pattern the maintenance mode (R3), the bot canary (R5-B) and the per-bot
// disk quota use. The vendor settings service strips unknown keys, so the
// vendor write path carries the key over via preserveBotImageRolloutGeneralKey
// (the call site in services/instance-settings.ts). The rollout script reads
// the env knobs at deploy time; the stored row OVERRIDES them inside the env
// bound (resolveBotImageRolloutSettings, packages/shared).

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import {
  BOT_IMAGE_ROLLOUT_SETTINGS_KEY,
  normalizeBotImageRolloutSettings,
  type BotImageRolloutSettings,
} from "@paperclipai/shared";

export const BOT_IMAGE_ROLLOUT_GENERAL_KEY = BOT_IMAGE_ROLLOUT_SETTINGS_KEY;
const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select">;

/** The stored rollout settings, or the empty override set when absent/corrupt. */
export async function readBotImageRolloutSettings(db: Runner): Promise<BotImageRolloutSettings> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return normalizeBotImageRolloutSettings(row?.general?.[BOT_IMAGE_ROLLOUT_GENERAL_KEY]);
}

/**
 * Read-modify-write the settings under a row lock. `change` returns the next
 * settings (or null to leave them as is) and a value handed back to the caller.
 */
export async function mutateBotImageRolloutSettings<T>(
  db: Db,
  change: (current: BotImageRolloutSettings) => { next: BotImageRolloutSettings | null; result: T },
): Promise<{ settings: BotImageRolloutSettings; result: T; changed: boolean }> {
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
    const current = normalizeBotImageRolloutSettings(row.general?.[BOT_IMAGE_ROLLOUT_GENERAL_KEY]);
    const { next, result } = change(current);
    if (!next) return { settings: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${BOT_IMAGE_ROLLOUT_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { settings: next, result, changed: true };
  });
}

/** Carry our key over a vendor write of instance_settings.general. */
export function preserveBotImageRolloutGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[BOT_IMAGE_ROLLOUT_GENERAL_KEY];
  return value === undefined ? {} : { [BOT_IMAGE_ROLLOUT_GENERAL_KEY]: value };
}
