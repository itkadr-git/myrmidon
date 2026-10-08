// server/src/myrmidon/monitoring/links/index.ts
//
// myrmidon(1.6.6 MONITORING E): the monitoring-link module's public surface —
// the routes the board mounts and the watchdog the heartbeat ticks.
//
// The alarm task is created through the ordinary issue service, with the
// ordinary idempotency ledger: the watchdog is a producer like any other, not
// a special path that could drift from the board's own rules (transitions,
// dedup, activity log, notifications).

import type { Db } from "@paperclipai/db";
import {
  createMonitoringLinkWatchdog,
  type MonitoringLinkAlertRef,
  type MonitoringLinkWatchdog,
} from "./watchdog.js";
import type { MonitoringLinkAlertTask } from "./alert.js";
import {
  findMonitoringLinkAlertIssue,
  listMonitoringLinkKeyRows,
  resolveMonitoringLinkAlertAssignee,
} from "./store.js";
import { monitoringLinkRoutes } from "./routes.js";

export * from "./health.js";
export * from "./alert.js";
export * from "./store.js";
export { monitoringLinkRoutes } from "./routes.js";
export {
  createMonitoringLinkWatchdog,
  DEFAULT_MONITORING_LINK_SWEEP_INTERVAL_SEC,
  MIN_MONITORING_LINK_SWEEP_INTERVAL_SEC,
  MAX_MONITORING_LINK_SWEEP_INTERVAL_SEC,
} from "./watchdog.js";
export type {
  MonitoringLinkAlertRef,
  MonitoringLinkSweepResult,
  MonitoringLinkWatchdog,
  MonitoringLinkWatchdogDeps,
} from "./watchdog.js";
export type { MonitoringLinkRoutesOptions } from "./routes.js";

type IssueService = ReturnType<
  typeof import("../../../services/issues.js")["issueService"]
>;

// Lazy, like the other myrmidon modules that file tasks: the issue service is
// heavy and importing it at module load would put it in front of every route.
let servicesPromise: Promise<{ issueService: (db: Db) => IssueService }> | null = null;
function loadIssueService() {
  servicesPromise ??= import("../../../services/issues.js").then((module) => ({
    issueService: module.issueService,
  }));
  return servicesPromise;
}

export function myrmidonMonitoringLinkRoutes(db: Db) {
  return monitoringLinkRoutes(db);
}

export function buildMonitoringLinkWatchdog(db: Db): MonitoringLinkWatchdog {
  return createMonitoringLinkWatchdog({
    listLinks: () => listMonitoringLinkKeyRows(db),
    resolveAlertAssignee: (companyId) => resolveMonitoringLinkAlertAssignee(db, companyId),
    createAlert: async (companyId, task) => {
      const { issueService } = await loadIssueService();
      const svc = issueService(db);
      const created = (await svc.create(companyId, {
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        assigneeAgentId: task.assigneeAgentId,
        originKind: task.originKind,
        idempotencyKey: task.idempotencyKey,
      } as never)) as
        | { id: string; identifier?: string | null; status?: string | null }
        | null;
      if (!created) {
        throw new Error(`monitoring link alarm create returned nothing (${task.idempotencyKey})`);
      }
      // The create dedups on the idempotency key, so this returns the *existing*
      // alarm when one is open. `status` is what tells the watchdog whether a
      // human closed the alarm while the link is still blind.
      const ref: MonitoringLinkAlertRef = {
        id: created.id,
        identifier: created.identifier ?? null,
        status: created.status ?? null,
      };
      return ref;
    },
    reopenAlert: async (companyId, issueId, comment) => {
      const { issueService } = await loadIssueService();
      const svc = issueService(db);
      await svc.update(issueId, { status: "todo", companyGuard: companyId } as never);
      await svc.addComment(issueId, comment, {}, { authorType: "system" });
    },
    closeAlert: async (companyId, idempotencyKey, comment) => {
      const alert = await findMonitoringLinkAlertIssue(db, companyId, idempotencyKey);
      if (!alert) return false;
      if (alert.status === "done" || alert.status === "cancelled") return false;
      const { issueService } = await loadIssueService();
      const svc = issueService(db);
      await svc.update(alert.issueId, { status: "done", companyGuard: companyId } as never);
      await svc.addComment(alert.issueId, comment, {}, { authorType: "system" });
      return true;
    },
  });
}

/** Kept for tests and callers that want the alert task shape without the DB. */
export type { MonitoringLinkAlertTask };