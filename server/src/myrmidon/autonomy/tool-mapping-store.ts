// myrmidon(1.6-AUTONOMY-GW): the configurable tool -> action class mapping.
//
// Same storage pattern as the rest of the autonomy module: the mapping lives
// under our own key of `instance_settings.general` (`myrmidonAutonomyToolMapping`),
// is read/written through the raw row (the vendor settings service strips
// unknown keys), changes take effect without a restart, and an env variable
// (`MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON`) is only a forced override for an
// instance that never saved the setting. Precedence: stored settings -> env
// -> built-in defaults; the effective source is reported by the resolver.

import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
import {
  DEFAULT_TOOL_AUTONOMY_MAPPING,
  resolveToolAutonomyClass,
  type ToolAutonomyMappingEntry,
} from "./tool-mapping.js";
import { AUTONOMY_TOOL_MAPPING_GENERAL_KEY } from "./store.js";

const SINGLETON_KEY = "default";

export type ToolMappingSource = "settings" | "env" | "default";

export interface ToolAutonomyMappingResolution {
  actionClass: ReturnType<typeof resolveToolAutonomyClass>;
  source: ToolMappingSource;
}

function isEntry(value: unknown): value is ToolAutonomyMappingEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ToolAutonomyMappingEntry).tool === "string" &&
    (value as ToolAutonomyMappingEntry).tool.length > 0 &&
    typeof (value as ToolAutonomyMappingEntry).actionClass === "string"
  );
}

function parseMapping(raw: unknown): ToolAutonomyMappingEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: ToolAutonomyMappingEntry[] = [];
  for (const item of raw) {
    if (!isEntry(item)) continue;
    entries.push({ tool: item.tool, actionClass: item.actionClass });
  }
  return entries;
}

async function readStoredMapping(db: Db): Promise<ToolAutonomyMappingEntry[] | null> {
  const [row] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .limit(1);
  const raw = row?.general?.[AUTONOMY_TOOL_MAPPING_GENERAL_KEY];
  if (raw === undefined || raw === null) return null;
  return parseMapping(raw);
}

function envMapping(): ToolAutonomyMappingEntry[] | null {
  const raw = process.env.MYRMIDON_TOOL_AUTONOMY_MAPPING_JSON;
  if (!raw || raw.trim().length === 0) return null;
  try {
    return parseMapping(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * The settings-backed mapping resolver the gateway consults per call: it
 * returns the action class plus the source the settings screen shows.
 * Precedence: stored settings -> env -> built-in defaults.
 */
export async function resolveToolAutonomyMapping(
  db: Db,
  toolName: string,
): Promise<ToolAutonomyMappingResolution> {
  const stored = await readStoredMapping(db);
  if (stored) {
    const actionClass = resolveToolAutonomyClass(toolName, stored);
    if (actionClass) return { actionClass, source: "settings" };
    return { actionClass: null, source: "settings" };
  }
  const fromEnv = envMapping();
  if (fromEnv) {
    const actionClass = resolveToolAutonomyClass(toolName, fromEnv);
    if (actionClass) return { actionClass, source: "env" };
    return { actionClass: null, source: "env" };
  }
  return { actionClass: resolveToolAutonomyClass(toolName, DEFAULT_TOOL_AUTONOMY_MAPPING), source: "default" };
}

/** Write the mapping (board settings screen / PATCH route). */
export async function writeToolAutonomyMapping(db: Db, entries: ToolAutonomyMappingEntry[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${AUTONOMY_TOOL_MAPPING_GENERAL_KEY}}`}::text[], ${JSON.stringify(entries)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
  });
}

/** The full mapping document (stored entries and the built-in defaults) for the settings UI. */
export async function readToolAutonomyMappingView(db: Db): Promise<{
  entries: ToolAutonomyMappingEntry[];
  source: ToolMappingSource;
  defaults: ToolAutonomyMappingEntry[];
}> {
  const stored = await readStoredMapping(db);
  if (stored) return { entries: stored, source: "settings", defaults: DEFAULT_TOOL_AUTONOMY_MAPPING };
  const fromEnv = envMapping();
  if (fromEnv) return { entries: fromEnv, source: "env", defaults: DEFAULT_TOOL_AUTONOMY_MAPPING };
  return { entries: DEFAULT_TOOL_AUTONOMY_MAPPING, source: "default", defaults: DEFAULT_TOOL_AUTONOMY_MAPPING };
}
