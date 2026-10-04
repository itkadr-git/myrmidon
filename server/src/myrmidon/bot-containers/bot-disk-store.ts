// myrmidon(1.6.1-BOT-DISK-B): the bot disk settings in instance_settings.general
// (`botDisk`), following the maintenance store pattern (row lock + jsonb_set).
// The vendor settings service strips keys its schema does not know, so this
// module reads and writes the raw row itself, and instance-settings.ts carries
// the key over every vendor write of `general`.
//
// Readers: the local Docker driver (the cache binds, docker-driver.ts) and the
// profile compiler (the variables pointing the tools at them, profile-compile.ts)
// both read the row on every reconcile pass, so a saved change applies on the
// next pass without restarting the server.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";

const SINGLETON_KEY = "default";
const BOT_DISK_GENERAL_KEY = "botDisk";

type Runner = Pick<Db, "select">;

export interface BotDiskSettings {
  /** Absolute host directory holding the shared package caches; absent = no shared cache. */
  sharedPackageCachePath?: string;
}

export function parseBotDiskSettings(storedGeneral: unknown): BotDiskSettings {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const botDisk = (storedGeneral as Record<string, unknown>)[BOT_DISK_GENERAL_KEY];
  if (typeof botDisk !== "object" || botDisk === null) return {};
  const path = (botDisk as Record<string, unknown>).sharedPackageCachePath;
  return typeof path === "string" && path.trim().length > 0 ? { sharedPackageCachePath: path.trim() } : {};
}

export async function readBotDiskSettings(db: Runner): Promise<BotDiskSettings> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseBotDiskSettings(row?.general);
}

/** Overwrite the stored settings under a row lock (the maintenance store pattern). */
export async function writeBotDiskSettings(db: Db, next: BotDiskSettings): Promise<BotDiskSettings> {
  const stored: BotDiskSettings = next.sharedPackageCachePath
    ? { sharedPackageCachePath: next.sharedPackageCachePath }
    : {};
  return db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${BOT_DISK_GENERAL_KEY}}`}::text[], ${JSON.stringify(stored)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return stored;
  });
}

/** Carry the `botDisk` key over a vendor write of instance_settings.general. */
export function preserveBotDiskGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[BOT_DISK_GENERAL_KEY];
  return value === undefined ? {} : { [BOT_DISK_GENERAL_KEY]: value };
}
