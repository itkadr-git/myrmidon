// server/src/myrmidon/monitoring/alertmanager-webhook-handler.ts
// myrmidon(1.7 MONITORING, OPE-12085): Alertmanager resolved webhook handler
// Automatically resolves open board tasks corresponding to Alertmanager alerts
// matched by fingerprint or fallback alertname. Returns 200 no-op if no open task.

import { Router, type Request, type Response } from "express";
import type { AlertDedupStore, DedupEntry } from "./alerts/store.js";

/** One alert object inside an Alertmanager webhook payload. */
export interface AlertmanagerWebhookAlert {
  status?: string;
  labels?: Record<string, string | undefined>;
  annotations?: Record<string, string | undefined>;
  startsAt?: string;
  endsAt?: string | null;
  generatorURL?: string;
  fingerprint?: string;
}

/** The standard Alertmanager webhook payload envelope. */
export interface AlertmanagerWebhookPayload {
  version?: string;
  groupKey?: string;
  truncatedAlerts?: number;
  status?: string;
  receiver?: string;
  groupLabels?: Record<string, string | undefined>;
  commonLabels?: Record<string, string | undefined>;
  commonAnnotations?: Record<string, string | undefined>;
  externalURL?: string;
  alerts?: AlertmanagerWebhookAlert[];
}

/** Open task representation returned by task finders. */
export interface AlertmanagerOpenTask {
  issueId: string;
  issueIdentifier?: string | null;
  status?: string;
  fingerprint?: string | null;
  alertname?: string | null;
}

/** Issue operations required to comment and close tasks. */
export interface AlertmanagerIssuePorts {
  updateStatus(issueId: string, status: string): Promise<unknown>;
  addComment(issueId: string, body: string): Promise<unknown>;
  createIssue?(
    companyId: string,
    input: {
      title: string;
      description: string;
      priority: string;
      assigneeAgentId?: string | null;
    },
  ): Promise<{ id: string; identifier: string | null; status: string }>;
}

/** Lookup contract for finding and marking open alert tasks. */
export interface AlertmanagerTaskFinder {
  findOpenTask(
    companyId: string,
    criteria: { fingerprint?: string | null; alertname?: string | null },
  ): Promise<AlertmanagerOpenTask | null>;
  markResolved?(
    companyId: string,
    criteria: { fingerprint?: string | null; alertname?: string | null; issueId: string },
    resolvedAt: string,
  ): Promise<unknown>;
}

export interface AlertmanagerWebhookHandlerDeps {
  companyId: string;
  issues: AlertmanagerIssuePorts;
  finder: AlertmanagerTaskFinder;
  now?: () => Date;
  renderComment?: (info: { alertname: string; fingerprint?: string | null; resolvedAt: string | null }) => string;
}

export interface AlertmanagerAlertOutcome {
  fingerprint: string | null;
  alertname: string | null;
  action: "resolve" | "noop" | "error";
  issueId: string | null;
  issueIdentifier?: string | null;
  status?: string;
  message?: string;
}

export interface AlertmanagerWebhookResult {
  status: "ok";
  processed: number;
  results: AlertmanagerAlertOutcome[];
}

/**
 * Standard auto-close comment formatting for Alertmanager alerts,
 * matching the phrasing used across Myrmidon monitoring modules.
 */
export function renderAlertmanagerAutoCloseComment(info: {
  alertname: string;
  fingerprint?: string | null;
  resolvedAt: string | null;
}): string {
  const when = info.resolvedAt ? new Date(info.resolvedAt).toISOString() : "recovery time unknown";
  const nameOrFp = info.fingerprint ? `${info.alertname} (${info.fingerprint})` : info.alertname;
  return `Recovered: the alertmanager alert ${nameOrFp} reported resolved at ${when}. Closing automatically.`;
}

/** Extracts normalized identifiers from an alert & payload pair. */
export function extractAlertmanagerAlertDetails(
  alert: AlertmanagerWebhookAlert,
  payload?: AlertmanagerWebhookPayload,
): {
  fingerprint: string | null;
  alertname: string | null;
  isResolved: boolean;
  resolvedAt: string | null;
} {
  const fingerprint = (alert.fingerprint && String(alert.fingerprint).trim()) || null;
  const labels = alert.labels ?? {};
  const commonLabels = payload?.commonLabels ?? {};
  const groupLabels = payload?.groupLabels ?? {};

  const alertname =
    (labels.alertname && String(labels.alertname).trim()) ||
    (labels.alert_name && String(labels.alert_name).trim()) ||
    (commonLabels.alertname && String(commonLabels.alertname).trim()) ||
    (commonLabels.alert_name && String(commonLabels.alert_name).trim()) ||
    (groupLabels.alertname && String(groupLabels.alertname).trim()) ||
    null;

  const alertStatus = (alert.status ?? "").toLowerCase().trim();
  const payloadStatus = (payload?.status ?? "").toLowerCase().trim();
  const isResolved = alertStatus === "resolved" || (!alertStatus && payloadStatus === "resolved");

  const resolvedAt = alert.endsAt ? String(alert.endsAt) : null;

  return { fingerprint, alertname, isResolved, resolvedAt };
}

/**
 * Adapts an existing AlertDedupStore to satisfy the AlertmanagerTaskFinder interface.
 * Matches open tasks by fingerprint first; falls back to alertname when present.
 */
export function adaptAlertDedupStore(
  store: AlertDedupStore & {
    findOpen?(
      companyId: string,
      source: "alertmanager",
      criteria: { fingerprint?: string | null; alertname?: string | null },
    ): Promise<DedupEntry | null>;
  },
): AlertmanagerTaskFinder {
  return {
    async findOpenTask(companyId, criteria) {
      if (criteria.fingerprint) {
        const direct = await store.get(companyId, "alertmanager", criteria.fingerprint);
        if (direct && direct.issueStatus === "open") {
          return {
            issueId: direct.issueId,
            issueIdentifier: direct.issueIdentifier,
            status: direct.issueStatus,
            fingerprint: criteria.fingerprint,
            alertname: criteria.alertname ?? null,
          };
        }
      }

      if (criteria.alertname) {
        const byName = await store.get(companyId, "alertmanager", criteria.alertname);
        if (byName && byName.issueStatus === "open") {
          return {
            issueId: byName.issueId,
            issueIdentifier: byName.issueIdentifier,
            status: byName.issueStatus,
            fingerprint: criteria.fingerprint ?? null,
            alertname: criteria.alertname,
          };
        }
      }

      if (typeof store.findOpen === "function") {
        const match = await store.findOpen(companyId, "alertmanager", criteria);
        if (match && match.issueStatus === "open") {
          return {
            issueId: match.issueId,
            issueIdentifier: match.issueIdentifier,
            status: match.issueStatus,
            fingerprint: criteria.fingerprint ?? null,
            alertname: criteria.alertname ?? null,
          };
        }
      }

      return null;
    },

    async markResolved(companyId, criteria, resolvedAt) {
      if (criteria.fingerprint) {
        await store.markResolved(companyId, "alertmanager", criteria.fingerprint, resolvedAt);
      }
      if (criteria.alertname) {
        await store.markResolved(companyId, "alertmanager", criteria.alertname, resolvedAt);
      }
    },
  };
}

/**
 * Processes an incoming Alertmanager webhook payload.
 * When status=resolved:
 * - Finds open task by fingerprint or fallback alertname
 * - Appends recovery comment and transitions status to "done"
 * - If no open task is found, acts as a no-op returning 200
 */
export async function handleAlertmanagerWebhook(
  payload: AlertmanagerWebhookPayload,
  deps: AlertmanagerWebhookHandlerDeps,
): Promise<AlertmanagerWebhookResult> {
  const now = deps.now ?? (() => new Date());
  const renderComment = deps.renderComment ?? renderAlertmanagerAutoCloseComment;

  const rawAlerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
  const alertsToProcess: AlertmanagerWebhookAlert[] =
    rawAlerts.length > 0
      ? rawAlerts
      : payload?.status
        ? [{ status: payload.status, labels: payload.commonLabels ?? payload.groupLabels ?? {} }]
        : [];

  const results: AlertmanagerAlertOutcome[] = [];

  for (const alert of alertsToProcess) {
    const { fingerprint, alertname, isResolved, resolvedAt } = extractAlertmanagerAlertDetails(
      alert,
      payload,
    );

    if (!isResolved) {
      results.push({
        fingerprint,
        alertname,
        action: "noop",
        issueId: null,
        status: "firing",
        message: "Alert status is not resolved; ignoring in resolved-webhook handler",
      });
      continue;
    }

    try {
      let openTask = await deps.finder.findOpenTask(deps.companyId, {
        fingerprint,
        alertname,
      });

      if (!openTask && fingerprint) {
        // The open task may have been created without the alert fingerprint (or the
        // fingerprint may have changed). Retry by alertname only so the resolved
        // hook still auto-closes the task.
        openTask = await deps.finder.findOpenTask(deps.companyId, {
          fingerprint: null,
          alertname,
        });
      }

      if (!openTask) {
        results.push({
          fingerprint,
          alertname,
          action: "noop",
          issueId: null,
          status: "ignored",
          message: "No open task found for alert (no-op 200)",
        });
        continue;
      }

      const effectiveResolvedAt = resolvedAt ?? now().toISOString();
      const commentBody = renderComment({
        alertname: alertname ?? openTask.alertname ?? "Alert",
        fingerprint: fingerprint ?? openTask.fingerprint ?? null,
        resolvedAt: effectiveResolvedAt,
      });

      await deps.issues.addComment(openTask.issueId, commentBody);
      await deps.issues.updateStatus(openTask.issueId, "done");

      if (deps.finder.markResolved) {
        await deps.finder.markResolved(
          deps.companyId,
          {
            fingerprint,
            alertname,
            issueId: openTask.issueId,
          },
          effectiveResolvedAt,
        );
      }

      results.push({
        fingerprint,
        alertname,
        action: "resolve",
        issueId: openTask.issueId,
        issueIdentifier: openTask.issueIdentifier ?? null,
        status: "done",
      });
    } catch (err) {
      results.push({
        fingerprint,
        alertname,
        action: "error",
        issueId: null,
        message: (err as Error)?.message ?? String(err),
      });
    }
  }

  return {
    status: "ok",
    processed: results.length,
    results,
  };
}

/**
 * Creates an Express route handler for Alertmanager webhook deliveries.
 * Responds with HTTP 200 and execution summary JSON for both resolved and no-op alerts.
 */
export function createAlertmanagerWebhookRouteHandler(
  depsFactory: AlertmanagerWebhookHandlerDeps | ((req: Request) => Promise<AlertmanagerWebhookHandlerDeps> | AlertmanagerWebhookHandlerDeps),
) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const deps = typeof depsFactory === "function" ? await depsFactory(req) : depsFactory;
      const result = await handleAlertmanagerWebhook(req.body, deps);
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({
        status: "error",
        error: (err as Error)?.message ?? "Internal error processing Alertmanager webhook",
      });
    }
  };
}

/**
 * Creates an Express router hosting the Alertmanager webhook endpoint on POST /.
 */
export function createAlertmanagerWebhookRouter(
  deps: AlertmanagerWebhookHandlerDeps | ((req: Request) => Promise<AlertmanagerWebhookHandlerDeps> | AlertmanagerWebhookHandlerDeps),
): Router {
  const router = Router();
  router.post("/", createAlertmanagerWebhookRouteHandler(deps));
  return router;
}
