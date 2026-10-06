// server/src/myrmidon/monitoring/alerts/routes.ts
// myrmidon(1.6.6-ALERTS): the alerts API.
//
//   POST  /api/myrmidon/monitoring/alerts/webhook   (token auth; Zabbix or Alertmanager payload)
//   GET   /api/myrmidon/monitoring/alerts/settings  (board; secret NAME only, never the value)
//   PATCH /api/myrmidon/monitoring/alerts/settings  (board)
//
// The webhook is the only endpoint without a session: it authorizes with the
// token named by MYRMIDON_ALERTS_WEBHOOK_TOKEN_REF (`env:<NAME>`/`file:<PATH>`,
// the maintenance/zabbix pattern). The token value is resolved per request,
// compared, and never logged or returned. Settings reads and writes need a
// board actor (company access + board).

import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { HttpError, unauthorized } from "../../../errors.js";
import { validate } from "../../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../../routes/authz.js";
import { logActivity } from "../../../services/activity-log.js";
import { logger } from "../../../middleware/logger.js";
import { issueService } from "../../../services/issues.js";
import { agents } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { alertPriority, detectAlertSource, parseAlertmanagerAlerts, parseZabbixAlert, type AlertRouteSettings } from "./domain.js";
import { createAlertService, tokenMatches, type AssigneeResolver, type IssuePorts } from "./service.js";
import {
  alertRoutesPatchSchema,
  alertSettingsView,
  ALERT_COMPANY_ID_ENV,
  createDbAlertSettingsStore,
  type AlertRoutesSettingsInput,
} from "./settings.js";
import { createDbAlertDedupStore, type AlertDedupStore } from "./store.js";
import { readAlertsSettings, resolveAlertTokenRef } from "./token.js";

export interface AlertRoutesDeps {
  db: Db;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests: the vendor issue service surface. */
  issuePorts?: IssuePorts;
  /** Injectable for tests: resolves role/agent names to agent ids. */
  assigneeResolver?: AssigneeResolver;
  /** Injectable for tests: returns the expected webhook token. */
  expectedToken?: () => string | null;
  /** Injectable for tests: the route-map settings store. */
  settingsStore?: {
    get(companyId: string): Promise<AlertRouteSettings>;
    put(companyId: string, input: AlertRoutesSettingsInput): Promise<AlertRouteSettings>;
  };
  /** Injectable for tests: the dedup registry store. */
  dedupStore?: AlertDedupStore;
  /** Injectable for tests: the audit-log writer. */
  auditLog?: typeof logActivity;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  if (!/^Bearer\s+/i.test(header)) throw unauthorized("Monitoring alerts webhook requires a Bearer token");
  return header.replace(/^Bearer\s+/i, "").trim();
}

/** The vendor issue surface, as the alerts feature consumes it. */
export function vendorIssuePorts(db: Db): IssuePorts {
  const svc = issueService(db);
  return {
    async createIssue(companyId, input) {
      const issue = await svc.create(companyId, {
        title: input.title,
        description: input.description,
        priority: input.priority,
        assigneeAgentId: input.assigneeAgentId,
      });
      return { id: issue.id, identifier: issue.identifier ?? null, status: issue.status };
    },
    async addComment(issueId, body) {
      return svc.addComment(issueId, body, {});
    },
    async updateStatus(issueId, status) {
      return svc.update(issueId, { status });
    },
  };
}

/** Resolves a role or agent name to an agent id of the company. */
export function dbAssigneeResolver(db: Db): AssigneeResolver {
  return {
    async resolve(companyId, assignee) {
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.name, assignee)))
        .limit(1);
      return rows[0]?.id ?? null;
    },
  };
}

export function monitoringAlertsRoutes(deps: AlertRoutesDeps) {
  const router = Router();
  const env = deps.env ?? process.env;
  const db = deps.db;
  const settingsStore = deps.settingsStore ?? createDbAlertSettingsStore(db);
  const dedupStore = deps.dedupStore ?? createDbAlertDedupStore(db);
  const writeAudit = deps.auditLog ?? logActivity;
  const issues = deps.issuePorts ?? vendorIssuePorts(db);
  const assigneeResolver = deps.assigneeResolver ?? dbAssigneeResolver(db);
  const service = createAlertService({ store: dedupStore, issues, assigneeResolver });
  const webhookSettings = readAlertsSettings(env);

  const companyId = (): string => {
    const configured = webhookSettings.companyId || (deps.env?.[ALERT_COMPANY_ID_ENV]?.trim() ?? env[ALERT_COMPANY_ID_ENV]?.trim());
    if (!configured) {
      throw new HttpError(503, "Monitoring alerts webhook is not configured: MYRMIDON_ALERTS_COMPANY_ID is unset");
    }
    return configured;
  };

  router.post("/myrmidon/monitoring/alerts/webhook", async (req, res) => {
    const token = bearerToken(req);
    const company = companyId();
    let expected: string | null;
    try {
      expected = deps.expectedToken ? deps.expectedToken() : resolveAlertTokenRef(webhookSettings.tokenRef, { env });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "monitoring alerts webhook: token reference failed to resolve");
      throw new HttpError(503, "Monitoring alerts webhook token is not available");
    }
    if (!expected) {
      logger.warn({ companyId: company }, "monitoring alerts webhook: token reference is not configured");
      throw new HttpError(503, "Monitoring alerts webhook is not configured");
    }
    if (!tokenMatches(expected, token)) throw unauthorized("Invalid monitoring alerts webhook token");

    const source = detectAlertSource(req.body);
    if (!source) {
      throw new HttpError(400, "Unrecognized monitoring alert payload: expected a Zabbix event or an Alertmanager webhook body");
    }
    const alerts = source === "zabbix" ? [parseZabbixAlert(req.body)!] : (parseAlertmanagerAlerts(req.body) ?? []);
    if (alerts.length === 0) throw new HttpError(400, "Monitoring alert payload carries no parsable alert");

    const settings = await settingsStore.get(company);
    const results: Array<{ identity: string; action: string; issueId: string | null; issueIdentifier: string | null }> = [];
    for (const alert of alerts) {
      try {
        const outcome = await service.handleAlert(company, alert, alertPriority(alert), settings);
        results.push(outcome);
        await writeAudit(db, {
          companyId: company,
          actorType: "system",
          actorId: "monitoring-alerts-webhook",
          action: `myrmidon.alerts.${outcome.action}`,
          entityType: "monitoring_alert",
          entityId: outcome.identity,
          details: { issueId: outcome.issueId, issueIdentifier: outcome.issueIdentifier },
        });
      } catch (err) {
        logger.error({ err }, "monitoring alerts webhook: one alert failed");
        results.push({ identity: `${alert.source}:${alert.key}`, action: "error", issueId: null, issueIdentifier: null });
      }
    }
    res.json({ processed: results.filter((r) => r.action !== "error").length, results });
  });

  router.get("/myrmidon/monitoring/alerts/settings", async (req, res) => {
    const company = typeof req.query.companyId === "string" ? req.query.companyId : companyId();
    assertCompanyAccess(req, company);
    assertBoard(req);
    res.json(alertSettingsView(await settingsStore.get(company)));
  });

  router.patch("/myrmidon/monitoring/alerts/settings", validate(alertRoutesPatchSchema), async (req, res) => {
    const body = req.body as z.infer<typeof alertRoutesPatchSchema>;
    assertCompanyAccess(req, body.companyId);
    assertBoard(req);
    const stored = await settingsStore.put(body.companyId, body.settings);
    const actor = getActorInfo(req);
    await writeAudit(db, {
      companyId: body.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "myrmidon.alerts.settings_saved",
      entityType: "monitoring_alerts_settings",
      entityId: body.companyId,
      details: {
        routes: stored.routes.length,
        defaultAssignee: stored.defaultAssignee,
        tokenSecretName: stored.tokenSecretName,
      },
    });
    res.json(alertSettingsView(stored));
  });

  return router;
}
