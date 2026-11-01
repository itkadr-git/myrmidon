import { and, eq, gte, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { Router } from "express";
import {
  agents,
  approvals,
  decisions,
  heartbeatRuns,
  inboxDismissals,
  issueThreadInteractions,
} from "@myrmidon/db";
import { costService } from "../services/costs.js";
import { accessService } from "../services/access.js";
import { assertCompanyAccess } from "./authz.js";

const ACTIVE_RUN_STATUSES = ["running"] as const;
const QUEUED_RUN_STATUSES = ["queued", "retrying"] as const;
const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;

function toTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function statusStripRoutes(db: Db) {
  const router = Router();
  const costs = costService(db);
  const access = accessService(db);

  router.get("/companies/:companyId/status-strip", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const accessDecision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!accessDecision.allowed) {
      res.status(403).json({ error: "Status strip is outside this actor's authorization boundary" });
      return;
    }
    const now = new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dismissedAtByKey = new Map<string, number>();
    if (req.actor.type === "board" && req.actor.userId) {
      const dismissals = await db.select({
        itemKey: inboxDismissals.itemKey,
        kind: inboxDismissals.kind,
        dismissedAt: inboxDismissals.dismissedAt,
        snoozedUntil: inboxDismissals.snoozedUntil,
      }).from(inboxDismissals).where(and(
        eq(inboxDismissals.companyId, companyId),
        eq(inboxDismissals.userId, req.actor.userId),
      ));
      for (const dismissal of dismissals) {
        const until = dismissal.kind === "snooze"
          ? toTimestamp(dismissal.snoozedUntil)
          : toTimestamp(dismissal.dismissedAt);
        if (until > 0) dismissedAtByKey.set(
          dismissal.itemKey,
          dismissal.kind === "snooze" && until > now.getTime() ? Number.MAX_SAFE_INTEGER : until,
        );
      }
    }
    const [agentRows, runRows, failedRuns, approvalsCount, decisionsCount, interactionsCount, cost] = await Promise.all([
      db.select({
        status: agents.status,
        count: sql<number>`count(*)::integer`,
      })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status),
      db.select({
        status: heartbeatRuns.status,
        count: sql<number>`count(*)::integer`,
      })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId))
        .groupBy(heartbeatRuns.status),
      db.select({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(agents.companyId, companyId),
          not(eq(agents.status, "terminated")),
          inArray(heartbeatRuns.status, ["failed", "timed_out"]),
          gte(heartbeatRuns.createdAt, dayStart),
        )),
      db.select({ id: approvals.id, updatedAt: approvals.updatedAt })
        .from(approvals)
        .where(and(
          eq(approvals.companyId, companyId),
          inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
        ))
        .then((rows) => rows.filter((row) =>
          (dismissedAtByKey.get(`approval:${row.id}`) ?? 0) < toTimestamp(row.updatedAt),
        ).length),
      db.select({ count: sql<number>`count(*)::integer` })
        .from(decisions)
        .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open")))
        .then((rows) => Number(rows[0]?.count ?? 0)),
      db.select({ count: sql<number>`count(*)::integer` })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .then((rows) => Number(rows[0]?.count ?? 0)),
      costs.summary(companyId, undefined, now),
    ]);
    const colony = { running: 0, idle: 0, paused: 0, error: 0 };
    for (const row of agentRows) {
      const count = Number(row.count);
      if (row.status === "running") colony.running += count;
      else if (row.status === "idle") colony.idle += count;
      else if (row.status === "paused") colony.paused += count;
      else if (row.status === "error") colony.error += count;
    }
    const failedToday = (failedRuns as Array<{ id: string; createdAt: Date | string }>).filter((run) => {
      const dismissedAt = dismissedAtByKey.get(`run:${run.id}`);
      return dismissedAt === undefined || toTimestamp(run.createdAt) > dismissedAt;
    }).length;
    const runs = { running: 0, queued: 0, failedToday };
    for (const row of runRows) {
      const count = Number(row.count);
      if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status)) runs.running += count;
      else if ((QUEUED_RUN_STATUSES as readonly string[]).includes(row.status)) runs.queued += count;
    }
    res.json({
      colony,
      runs,
      costs: {
        monthSpendCents: cost.spendCents,
        budgetCents: cost.budgetCents,
        unpricedEvents: cost.unpricedEvents,
        forecastCents: cost.forecastCents,
      },
      waiting: {
        approvals: approvalsCount,
        decisions: decisionsCount,
        interactions: interactionsCount,
      },
    });
  });

  return router;
}
