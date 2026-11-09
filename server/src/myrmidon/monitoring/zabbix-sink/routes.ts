// server/src/myrmidon/monitoring/zabbix-sink/routes.ts
// myrmidon(1.7-ZABBIX-SINK): the Zabbix alarm sink API.
//
//   POST  /api/monitoring/zabbix-webhook   (token auth; one Zabbix media-type event per request)
//
// The sink is the only endpoint without a session: it authorizes with the
// token named by MYRMIDON_ZABBIX_SINK_TOKEN_REF (`env:<NAME>`/`file:<PATH>`,
// the alerts-webhook pattern; since 1.7 the token is a stub that can be
// replaced by the signed intake). The token value is resolved per request,
// compared, and never logged or returned. A valid payload creates a role-task
// draft (title from the trigger, priority from the severity, the Zabbix URL
// as the source link); a repeated eventid returns the existing draft; an
// invalid payload answers 400.

import { Router, type Request } from "express";
import { readFileSync } from "node:fs";
import type { Db } from "@myrmidon/db";
import { HttpError, unauthorized } from "../../../errors.js";
import { logActivity } from "../../../services/activity-log.js";
import { logger } from "../../../middleware/logger.js";
import { issueService } from "../../../services/issues.js";
import { parseZabbixSinkEvent } from "./domain.js";
import { createZabbixSinkService, type SinkIssuePorts } from "./service.js";
import { createDbZabbixSinkDedupStore, type ZabbixSinkDedupStore } from "./store.js";
import { resolveAlertTokenRef, ALERTS_COMPANY_ID_ENV } from "../alerts/token.js";

export const ZABBIX_SINK_TOKEN_REF_ENV = "MYRMIDON_ZABBIX_SINK_TOKEN_REF";

export interface ZabbixSinkRoutesDeps {
  db: Db;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests: the vendor issue service surface. */
  issuePorts?: SinkIssuePorts;
  /** Injectable for tests: returns the expected webhook token. */
  expectedToken?: () => string | null;
  /** Injectable for tests: the dedup store. */
  dedupStore?: ZabbixSinkDedupStore;
  /** Injectable for tests: the audit-log writer. */
  auditLog?: typeof logActivity;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  if (!/^Bearer\s+/i.test(header)) throw unauthorized("Zabbix sink requires a Bearer token");
  return header.replace(/^Bearer\s+/i, "").trim();
}

function tokenMatches(expected: string | null, actual: string | undefined): boolean {
  if (!expected || !actual || expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

/** The vendor issue surface, as the sink consumes it. Drafts are unassigned `todo`. */
export function vendorSinkIssuePorts(db: Db): SinkIssuePorts {
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
  };
}

export function zabbixSinkRoutes(deps: ZabbixSinkRoutesDeps) {
  const router = Router();
  const env = deps.env ?? process.env;
  const db = deps.db;
  const issues = deps.issuePorts ?? vendorSinkIssuePorts(db);
  const dedupStore = deps.dedupStore ?? createDbZabbixSinkDedupStore(db);
  const writeAudit = deps.auditLog ?? logActivity;
  const service = createZabbixSinkService({ store: dedupStore, issues });

  function sinkTokenRef(): string | null {
    return env[ZABBIX_SINK_TOKEN_REF_ENV]?.trim() || null;
  }

  function resolveToken(): string | null {
    if (deps.expectedToken) return deps.expectedToken();
    const ref = sinkTokenRef();
    if (!ref) return null;
    try {
      return resolveAlertTokenRef(ref, {
        env,
        readFile: (path: string) => readFileSync(path, "utf8"),
      });
    } catch {
      return null;
    }
  }

  function companyId(): string {
    const configured = env[ALERTS_COMPANY_ID_ENV]?.trim();
    if (!configured) {
      throw new HttpError(503, "Zabbix sink is not configured: MYRMIDON_ALERTS_COMPANY_ID is unset");
    }
    return configured;
  }

  router.post("/monitoring/zabbix-webhook", async (req, res) => {
    const expected = resolveToken();
    if (!expected) {
      logger.warn("monitoring zabbix sink: token reference is not configured");
      throw new HttpError(503, "Zabbix sink is not configured");
    }
    if (!tokenMatches(expected, bearerToken(req))) throw unauthorized("Invalid zabbix sink token");

    const event = parseZabbixSinkEvent(req.body);
    if (!event) {
      throw new HttpError(400, "Invalid Zabbix webhook payload: expected an event with eventid and name");
    }

    const outcome = await service.handleEvent(companyId(), event);
    await writeAudit(db, {
      companyId: companyId(),
      actorType: "system",
      actorId: "zabbix-sink",
      action: `myrmidon.zabbix_sink.${outcome.action}`,
      entityType: "monitoring_zabbix_event",
      entityId: outcome.eventId,
      details: { issueId: outcome.issueId, issueIdentifier: outcome.issueIdentifier },
    });
    res.status(200).json({
      eventid: outcome.eventId,
      action: outcome.action,
      issue_id: outcome.issueId,
      issue_identifier: outcome.issueIdentifier,
    });
  });

  return router;
}
