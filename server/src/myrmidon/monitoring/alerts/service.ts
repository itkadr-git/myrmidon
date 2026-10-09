// server/src/myrmidon/monitoring/alerts/service.ts
// myrmidon(1.6.6-ALERTS): orchestration of one alert — the dedup decision, the
// board-issue create/update/auto-close and the audit row. The issue ports
// wrap the vendor issueService so tests inject fakes; the token check is a
// pure comparison against the resolved secret value.
//
// Errors here are caught per alert: one bad alert answers 500 for that alert
// only in the route, never stops the batch.

import { issueTitleFor, issueBodyFor, routeAssignee, routeMatch, decideDedup, updateCommentFor, resolvedCommentFor, alertIdentity, type AlertPriority, type NormalizedAlert } from "./domain.js";
import type { AlertDedupStore, DedupEntry } from "./store.js";
import type { AlertRouteSettings } from "./domain.js";

/** Resolves an assignee name to an agent id; null = unassigned. */
export interface AssigneeResolver {
  resolve(companyId: string, assignee: string): Promise<string | null>;
}

/** The vendor issue surface this feature needs; issueService(db) satisfies it. */
export interface IssuePorts {
  createIssue(
    companyId: string,
    input: {
      title: string;
      description: string;
      priority: string;
      assigneeAgentId: string | null;
    },
  ): Promise<{ id: string; identifier: string | null; status: string }>;
  addComment(issueId: string, body: string): Promise<unknown>;
  updateStatus(issueId: string, status: string): Promise<unknown>;
}

export interface AlertOutcome {
  identity: string;
  action: "create" | "update" | "resolve" | "ignore";
  issueId: string | null;
  issueIdentifier: string | null;
}

export interface AlertServiceDeps {
  store: AlertDedupStore;
  issues: IssuePorts;
  assigneeResolver: AssigneeResolver;
  now?: () => Date;
}

export function createAlertService(deps: AlertServiceDeps) {
  const now = deps.now ?? (() => new Date());

  async function handleAlert(
    companyId: string,
    alert: NormalizedAlert,
    priority: AlertPriority,
    settings: AlertRouteSettings,
  ): Promise<AlertOutcome> {
    const identity = alertIdentity(alert);
    const existing: DedupEntry | null = await deps.store.get(companyId, alert.source, alert.key);
    const decision = decideDedup(alert, existing);

    if (decision.action === "ignore") {
      return { identity, action: "ignore", issueId: existing?.issueId ?? null, issueIdentifier: existing?.issueIdentifier ?? null };
    }

    if (decision.action === "create") {
      const assigneeName = routeAssignee(alert, settings.routes, settings.defaultAssignee);
      const assigneeAgentId = await deps.assigneeResolver.resolve(companyId, assigneeName);
      const matched = routeMatch(alert, settings.routes);
      const issue = await deps.issues.createIssue(companyId, {
        title: issueTitleFor(alert),
        description: issueBodyFor(alert, matched?.runbook),
        priority,
        assigneeAgentId,
      });
      const entry = await deps.store.upsert(companyId, alert.source, alert.key, {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
      });
      return { identity, action: "create", issueId: entry.issueId, issueIdentifier: entry.issueIdentifier };
    }

    // update / resolve both target the existing issue
    const target = existing!;
    if (decision.action === "update") {
      await deps.issues.addComment(target.issueId, updateCommentFor(alert, now()));
      const refreshed = await deps.store.upsert(companyId, alert.source, alert.key, {
        issueId: target.issueId,
        issueIdentifier: target.issueIdentifier,
      });
      return { identity, action: "update", issueId: refreshed.issueId, issueIdentifier: refreshed.issueIdentifier };
    }

    await deps.issues.addComment(target.issueId, resolvedCommentFor(alert, alert.resolvedAt));
    await deps.issues.updateStatus(target.issueId, "done");
    await deps.store.markResolved(companyId, alert.source, alert.key, alert.resolvedAt ?? now().toISOString());
    return { identity, action: "resolve", issueId: target.issueId, issueIdentifier: target.issueIdentifier };
  }

  return { handleAlert };
}

/** Constant-time-ish comparison; both values are already in memory. */
export function tokenMatches(expected: string | null | undefined, received: string | undefined): boolean {
  if (!expected || !received) return false;
  const a = expected.trim();
  const b = received.trim();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
