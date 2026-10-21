import { eq } from "drizzle-orm";
import { nestRedactSettings, type Db } from "@paperclipai/db";
import { defaultNestRedactConfig, mergeNestRedactConfig, type NestRedactConfig, type NestRedactConfigPatch } from "@paperclipai/shared";

export async function readNestRedactConfig(db: Db, nestId: string): Promise<NestRedactConfig> {
  const row = await db.select({ config: nestRedactSettings.config }).from(nestRedactSettings)
    .where(eq(nestRedactSettings.nestId, nestId)).then((rows) => rows[0]);
  return mergeNestRedactConfig(undefined, row?.config as NestRedactConfigPatch | undefined ?? {});
}

export async function writeNestRedactConfig(db: Db, nestId: string, patch: NestRedactConfigPatch): Promise<NestRedactConfig> {
  const current = await readNestRedactConfig(db, nestId);
  const next = mergeNestRedactConfig(current, patch);
  await db.insert(nestRedactSettings).values({ nestId, config: next as unknown as Record<string, unknown> })
    .onConflictDoUpdate({ target: nestRedactSettings.nestId, set: { config: next as unknown as Record<string, unknown>, updatedAt: new Date() } });
  return next;
}

export function nestRedactDefaults(): NestRedactConfig { return defaultNestRedactConfig(); }
