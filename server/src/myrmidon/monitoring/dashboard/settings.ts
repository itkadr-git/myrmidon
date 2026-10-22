// server/src/myrmidon/monitoring/dashboard/settings.ts
// myrmidon(1.6.6 MONITORING C): connection settings of the fleet dashboard,
// stored in instance_settings.general under one key (the maintenance/alerts
// pattern). Settings carry ADDRESSES and the token REFERENCE names only —
// secret values are resolved per request (env:/file:, the maintenance/zabbix
// pattern) and are never returned and never logged.
//
// Scope: this module OWNS the sub-document `myrmidonMonitoringDashboard` and
// the shared base route GET/PATCH /api/myrmidon/monitoring (part B shipped no
// base route on main, so this part C introduces it; any later part extends the
// stored object additively — unknown keys are preserved verbatim on write).

import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";

export const MONITORING_SETTINGS_GENERAL_KEY = "myrmidonMonitoringDashboard";
const SINGLETON_KEY = "default";

const tokenRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^(env|file):/, "token reference must be env:<NAME> or file:<PATH>");

export const monitoringConnectionSettingsSchema = z
  .object({
    /** Base URL of VictoriaMetrics (for example `http://vm:8428`). Null = VM source off. */
    vmUrl: z.string().trim().max(500).nullable().default(null),
    /** Optional read-token reference for VM (`env:<NAME>` / `file:<PATH>`); value never stored here. */
    vmTokenRef: tokenRefSchema.nullable().default(null),
    /** Base URL of the Zabbix API (the api_jsonrpc.php endpoint). Null = Zabbix source off. */
    zabbixUrl: z.string().trim().max(500).nullable().default(null),
    /** Read-token reference for the Zabbix API; value never stored here. */
    zabbixTokenRef: tokenRefSchema.nullable().default(null),
    /** PromQL label value selecting the fleet's node_exporter jobs (used as `job=~"..."`). */
    vmJobSelector: z.string().trim().min(1).max(200).default("node"),
    /** Zabbix host groups whose hosts the dashboard reads. Empty = all groups. */
    zabbixHostGroups: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    /** Per-source request timeout. */
    timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
  })
  .strict();

export type MonitoringConnectionSettings = z.infer<typeof monitoringConnectionSettingsSchema>;

export const DEFAULT_MONITORING_CONNECTION_SETTINGS: MonitoringConnectionSettings =
  monitoringConnectionSettingsSchema.parse({});

/**
 * Patch schema: every field optional, unknown keys rejected. A PATCH merges
 * into the stored document; fields absent from the patch keep their value.
 */
export const monitoringConnectionPatchSchema = monitoringConnectionSettingsSchema.partial().strict();

export type MonitoringConnectionPatch = z.infer<typeof monitoringConnectionPatchSchema>;

function parseStored(raw: unknown): MonitoringConnectionSettings {
  const parsed = monitoringConnectionSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_MONITORING_CONNECTION_SETTINGS;
}

type Runner = Pick<Db, "select" | "update" | "insert">;

export interface MonitoringSettingsStore {
  get(companyId: string): Promise<MonitoringConnectionSettings>;
  patch(companyId: string, patch: MonitoringConnectionPatch): Promise<MonitoringConnectionSettings>;
}

/**
 * Reads and writes the stored settings, falling back to the defaults per
 * company. The write is a read-modify-write on the instance row, the same
 * lock-free shape the alerts settings use; company-scoped subdocuments of
 * OTHER companies and unknown sibling keys are preserved verbatim.
 */
export function createDbMonitoringSettingsStore(db: Runner): MonitoringSettingsStore {
  async function readGeneral(): Promise<Record<string, unknown>> {
    const row = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    return (row?.general ?? {}) as Record<string, unknown>;
  }

  return {
    async get(companyId: string) {
      const general = await readGeneral();
      const scoped = (general[MONITORING_SETTINGS_GENERAL_KEY] as Record<string, unknown> | undefined)?.[
        companyId
      ];
      return parseStored(scoped);
    },
    async patch(companyId: string, patch: MonitoringConnectionPatch) {
      const general = await readGeneral();
      const bucket = (general[MONITORING_SETTINGS_GENERAL_KEY] ?? {}) as Record<string, unknown>;
      const current = parseStored(bucket[companyId]);
      const next: MonitoringConnectionSettings = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        (next as Record<string, unknown>)[key] = value;
      }
      general[MONITORING_SETTINGS_GENERAL_KEY] = { ...bucket, [companyId]: next };
      await db
        .update(instanceSettings)
        .set({ general })
        .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
      return next;
    },
  };
}

/** The board-facing view: addresses and token REFERENCE names only — never a secret value. */
export function monitoringSettingsView(settings: MonitoringConnectionSettings) {
  return {
    vmUrl: settings.vmUrl,
    vmTokenRef: settings.vmTokenRef,
    zabbixUrl: settings.zabbixUrl,
    zabbixTokenRef: settings.zabbixTokenRef,
    vmJobSelector: settings.vmJobSelector,
    zabbixHostGroups: settings.zabbixHostGroups,
    timeoutMs: settings.timeoutMs,
  };
}
