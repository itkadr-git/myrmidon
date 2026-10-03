// myrmidon(1.6.1-BOT-DISK-B): preserve the bot disk settings across vendor writes
// of instance_settings.general, following the maintenance store pattern (row-lock +
// jsonb_set). The vendor settings service strips unknown keys, so this module
// reads and writes the raw row itself; instance-settings.ts preserves the key
// across vendor general writes.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";

const SINGLETON_KEY = "default";

type Runner = Pick<Db, "select" | "insert" | "update">;

export interface BotDiskSettings {
  sharedPackageCachePath?: string;
}

export interface SharedSettings {
  enabled?: boolean;
  path?: string;
}

export interface CombinedBotDiskSettings {
  sharedPackageCachePath?: string;
  shared?: SharedSettings;
}

const BOT_DISK_GENERAL_KEY = "botDisk";
const SHARED_GENERAL_KEY = "shared";

export function parseBotDiskSettings(storedGeneral: unknown): BotDiskSettings {
  if (typeof storedGeneral !== "object" || storedGeneral === null) {
    return {};
  }
  const botDisk = (storedGeneral as Record<string, unknown>)[BOT_DISK_GENERAL_KEY];
  if (typeof botDisk !== "object" || botDisk === null) {
    return {};
  }
  const parsed = botDisk as Record<string, unknown>;
  const settings: BotDiskSettings = {};
  if (typeof parsed.sharedPackageCachePath === "string" && parsed.sharedPackageCachePath.trim().length > 0) {
    settings.sharedPackageCachePath = parsed.sharedPackageCachePath;
  }
  return settings;
}

export function parseSharedSettings(storedGeneral: unknown): SharedSettings {
  if (typeof storedGeneral !== "object" || storedGeneral === null) {
    return {};
  }
  const shared = (storedGeneral as Record<string, unknown>)[SHARED_GENERAL_KEY];
  if (typeof shared !== "object" || shared === null) {
    return {};
  }
  const parsed = shared as Record<string, unknown>;
  const settings: SharedSettings = {};
  if (typeof parsed.enabled === "boolean") {
    settings.enabled = parsed.enabled;
  }
  if (typeof parsed.path === "string" && parsed.path.trim().length > 0) {
    settings.path = parsed.path;
  }
  return settings;
}

export function parseCombinedSettings(storedGeneral: unknown): CombinedBotDiskSettings {
  return {
    sharedPackageCachePath: parseBotDiskSettings(storedGeneral).sharedPackageCachePath,
    shared: parseSharedSettings(storedGeneral),
  };
}

export async function readBotDiskSettings(db: Runner): Promise<BotDiskSettings> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseBotDiskSettings(row?.general);
}

export async function readCombinedSettings(db: Runner): Promise<CombinedBotDiskSettings> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return parseCombinedSettings(row?.general);
}

/** Overwrite the cached document under a row lock (the maintenance store pattern). */
export async function writeBotDiskSettings(db: Db, next: BotDiskSettings): Promise<BotDiskSettings> {
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
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), '{${BOT_DISK_GENERAL_KEY}}'::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return next;
  });
}

/** Overwrite the combined settings under a row lock (the maintenance store pattern). */
export async function writeCombinedSettings(db: Db, next: CombinedBotDiskSettings): Promise<CombinedBotDiskSettings> {
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
    
    // Update both botDisk and shared settings
    let general = sql`coalesce(${instanceSettings.general}, '{}'::jsonb)`;
    if (next.sharedPackageCachePath !== undefined) {
      general = sql`jsonb_set(${general}, '{${BOT_DISK_GENERAL_KEY}}'::text[], jsonb_build_object('sharedPackageCachePath', ${next.sharedPackageCachePath}), true)`;
    }
    if (next.shared) {
      general = sql`jsonb_set(${general}, '{${SHARED_GENERAL_KEY}}'::text[], ${JSON.stringify(next.shared)}::jsonb, true)`;
    }
    
    await tx
      .update(instanceSettings)
      .set({ general })
      .where(eq(instanceSettings.id, row.id));
    return next;
  });
}

/** Carry our keys over a vendor write of instance_settings.general. */
export function preserveBotDiskGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const botDiskValue = (storedGeneral as Record<string, unknown>)[BOT_DISK_GENERAL_KEY];
  const sharedValue = (storedGeneral as Record<string, unknown>)[SHARED_GENERAL_KEY];
  const result: Record<string, unknown> = {};
  if (botDiskValue !== undefined) result[BOT_DISK_GENERAL_KEY] = botDiskValue;
  if (sharedValue !== undefined) result[SHARED_GENERAL_KEY] = sharedValue;
  return result;
}