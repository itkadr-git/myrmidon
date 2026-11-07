import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { Router } from "express";
import {
  agents,
  decisions,
  heartbeatRuns,
  inboxDismissals,
  issueThreadInteractions,
} from "@myrmidon/db";
import { costService } from "../services/costs.js";
import { accessService } from "../services/access.js";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { getUtcMonthStart } from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";

const ACTIVE_RUN_STATUSES = ["running"] as const;
const QUEUED_RUN_STATUSES = ["queued", "retrying"] as const;

function buildDismissedAtByKey(
  dismissals: Array<{ itemKey: string; kind: string; dismissedAt: Date | string; snoozedUntil: Date | string | null }>,
): Map<string, number> {
  const now = Date.now();
  const entries: Array<[string, number]> = [];
  for (const dismissal of dismissals) {
    if (dismissal.kind === "snooze") {
      const snoozedUntil = dismissal.snoozedUntil ? new Date(dismissal.snoozedUntil).getTime() : 0;
      if (Number.isFinite(snoozedUntil) && snoozedUntil > now) entries.push([dismissal.itemKey, Number.MAX_SAFE_INTEGER]);
      continue;
    }
    entries.push([dismissal.itemKey, new Date(dismissal.dismissedAt).getTime()]);
  }
  return new Map(entries);
}

export function statusStripRoutes(db: Db) {
  const router = Router();
  const costs = costService(db);
  const access = accessService(db);
  const sidebarBadges = sidebarBadgeService(db);

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
    const dismissedAtByKey =
      req.actor.type === "board" && req.actor.userId
        ? await db
          .select({
            itemKey: inboxDismissals.itemKey,
            kind: inboxDismissals.kind,
            dismissedAt: inboxDismissals.dismissedAt,
            snoozedUntil: inboxDismissals.snoozedUntil,
          })
          .from(inboxDismissals)
          .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, req.actor.userId)))
          .then(buildDismissedAtByKey)
        : new Map<string, number>();

    const [agentRows, runRows, badges, decisionsCount, interactionsCount, cost] = await Promise.all([
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
      sidebarBadges.get(companyId, {
        dismissals: dismissedAtByKey,
      }),
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
      // Month basis is intentional: monthSpendCents, unpricedEvents and
      // forecastCents share the monthly budget context of the header chip.
      // Dashboard computes monthSpendCents from the UTC month start (gte
      // only), so pass the same floor here to match dashboard monthly spend.
      costs.summary(companyId, { from: getUtcMonthStart(now) }, now),
    ]);
    const colony = { running: 0, idle: 0, paused: 0, error: 0 };
    for (const row of agentRows) {
      const count = Number(row.count);
      if (row.status === "running") colony.running += count;
      else if (row.status === "idle") colony.idle += count;
      else if (row.status === "paused") colony.paused += count;
      else if (row.status === "error") colony.error += count;
    }
    const runs = { running: 0, queued: 0, failedToday: badges.failedRuns };
    for (const row of runRows) {
      const count = Number(row.count);
      if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status)) runs.running += count;
      else if ((QUEUED_RUN_STATUSES as readonly string[]).includes(row.status)) runs.queued += count;
    }
    res.json({
      colony,
      runs,
      costs: {
        monthSpendCents: cost.spendCents ?? 0,
        budgetCents: cost.budgetCents ?? 0,
        unpricedEvents: cost.unpricedEvents ?? 0,
        forecastCents: cost.forecastCents ?? null,
      },
      waiting: {
        approvals: badges.approvals,
        decisions: decisionsCount,
        interactions: interactionsCount,
      },
    });
  });

  return router;
}
