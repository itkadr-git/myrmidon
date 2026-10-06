// server/src/myrmidon/monitoring/alerts/settings.ts
// myrmidon(1.6.6-ALERTS): route-map settings of the alerts webhook, stored in
// instance_settings.general under our key (the maintenance-mode pattern). The
// token secret NAME lives here; the token VALUE is resolved at request time and
// never returned, never logged. See docs/myrmidon/SETTINGS.md.

import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  DEFAULT_ALERT_ROUTE_ASSIGNEE,
  MAX_ALERT_ROUTES,
  type AlertRouteRule,
  type AlertRouteSettings,
} from "./domain.js";

export const ALERT_ROUTES_GENERAL_KEY = "myrmidonAlertRoutes";
const SINGLETON_KEY = "default";

/** Company whose settings the webhook uses; env override for tests and single-company boxes. */
export const ALERT_COMPANY_ID_ENV = "MYRMIDON_ALERTS_COMPANY_ID";

/** Default secret name for the webhook token. */
export const ALERT_TOKEN_SECRET_DEFAULT = "monitoring-alerts-token";

export const alertRouteRuleSchema = z
  .object({
    match: z.string().trim().min(1).max(120),
    assignee: z.string().trim().min(1).max(120),
    runbook: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  })
  .strict();

export const alertRoutesSettingsSchema = z
  .object({
    routes: z.array(alertRouteRuleSchema).max(MAX_ALERT_ROUTES).default([]),
    defaultAssignee: z.string().trim().min(1).max(120).default(DEFAULT_ALERT_ROUTE_ASSIGNEE),
    tokenSecretName: z.string().trim().min(1).max(120).default(ALERT_TOKEN_SECRET_DEFAULT),
  })
  .strict();

export type AlertRoutesSettingsInput = z.infer<typeof alertRoutesSettingsSchema>;

const DEFAULTS: AlertRoutesSettingsInput = {
  routes: [],
  defaultAssignee: DEFAULT_ALERT_ROUTE_ASSIGNEE,
  tokenSecretName: ALERT_TOKEN_SECRET_DEFAULT,
};

function parseStored(raw: unknown): AlertRoutesSettingsInput {
  const parsed = alertRoutesSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULTS;
}

type Runner = Pick<Db, "select" | "update" | "insert">;

export interface AlertSettingsStore {
  get(companyId: string): Promise<AlertRouteSettings>;
  put(companyId: string, input: AlertRoutesSettingsInput): Promise<AlertRouteSettings>;
}

/** Reads the stored settings, falling back to the defaults per company. */
export function createDbAlertSettingsStore(db: Runner): AlertSettingsStore {
  async function readRaw(companyId: string): Promise<AlertRoutesSettingsInput | null> {
    const row = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    const stored = row?.general?.[ALERT_ROUTES_GENERAL_KEY];
    if (stored === undefined) return null;
    const scoped = (stored as Record<string, unknown> | null)?.[companyId];
    return parseStored(scoped);
  }

  return {
    async get(companyId: string) {
      const raw = await readRaw(companyId);
      return { companyId, ...raw ?? DEFAULTS } satisfies AlertRouteSettings;
    },
    async put(companyId: string, input: AlertRoutesSettingsInput) {
      // Read-modify-write under the instance row; the same lock-free shape as
      // the maintenance key write (the vendor settings service strips unknown
      // keys, so this module owns the whole subdocument).
      const current = (await readRaw(companyId)) ?? DEFAULTS;
      void current;
      const row = await db
        .select({ general: instanceSettings.general })
        .from(instanceSettings)
        .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
        .then((rows) => rows[0] ?? null);
      const general = (row?.general ?? {}) as Record<string, unknown>;
      const stored = (general[ALERT_ROUTES_GENERAL_KEY] ?? {}) as Record<string, unknown>;
      const next = { ...stored, [companyId]: input };
      general[ALERT_ROUTES_GENERAL_KEY] = next;
      await db
        .update(instanceSettings)
        .set({ general })
        .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
      return { companyId, ...input } satisfies AlertRouteSettings;
    },
  };
}

/** The board-facing view: never includes any secret value (only its name). */
export function alertSettingsView(settings: AlertRouteSettings) {
  return {
    companyId: settings.companyId,
    routes: settings.routes,
    defaultAssignee: settings.defaultAssignee,
    tokenSecretName: settings.tokenSecretName,
  };
}

/** The board-facing PATCH schema: company access and board role are checked in the routes. */
export const alertRoutesPatchSchema = z
  .object({
    companyId: z.string().uuid(),
    settings: alertRoutesSettingsSchema,
  })
  .strict();

export type { AlertRouteRule };
