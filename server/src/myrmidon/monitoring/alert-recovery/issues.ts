import { and, eq } from "drizzle-orm";
import { ALERT_RECOVERY_ORIGIN_KIND, isAgentStatusInvokable } from "@paperclipai/shared";
import { issues, type Db } from "@paperclipai/db";
import { logger } from "../../../middleware/logger.js";
import { listAgentsOfRole } from "../../swarm-claim/queue.js";
import type { AlertRecoveryIssuePort, AlertRecoveryIssueWriteResult } from "./service.js";

/**
 * The issue side of alert recovery on the real database (myrmidon 1.6.6
 * MONITORING, part D).
 *
 * Everything here is deliberately narrow: the module only ever touches tasks it
 * opened itself. Each write re-reads the row under a lock and refuses when the
 * task is not an alert-recovery task any more, so an operator who takes a task
 * over — or a person who closes it by hand — is never overruled by the sweep.
 */

type IssueRow = typeof issues.$inferSelect;

async function loadIssueService() {
  return (await import("../../../services/index.js")).issueService;
}

/** The agent of the owner role the task goes to: an invokable one, picked stably. */
async function ownerAgentId(db: Db, companyId: string, ownerRole: string): Promise<string | null> {
  const rows = await listAgentsOfRole(db, companyId, ownerRole);
  const invokable = rows.filter((row) => isAgentStatusInvokable(row.status));
  const pool = invokable.length > 0 ? invokable : rows;
  const sorted = pool
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  return sorted[0]?.id ?? null;
}

export function createDbAlertRecoveryIssuePort(db: Db): AlertRecoveryIssuePort {
  async function guardedWrite(input: {
    issueId: string;
    companyId: string;
    guard: (current: IssueRow) => boolean;
    build: (current: IssueRow) => Record<string, unknown>;
    comment: string;
  }): Promise<AlertRecoveryIssueWriteResult> {
    const issueService = await loadIssueService();
    try {
      return await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const [current] = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
          .limit(1)
          .for("update");
        if (!current || current.originKind !== ALERT_RECOVERY_ORIGIN_KIND) return "refused";
        if (!input.guard(current)) return "already";
        const svc = issueService(txDb);
        const updated = await svc.update(input.issueId, input.build(current) as never, tx);
        if (!updated) return "refused";
        await svc.addComment(input.issueId, input.comment, {}, { authorType: "system" }, tx);
        return "applied";
      });
    } catch (error) {
      // A refused transition (a locked assignee, a guard) is left to the next
      // pass of the sweep or to a person.
      logger.warn({ err: error, issueId: input.issueId }, "alert recovery issue write refused");
      return "refused";
    }
  }

  return {
    async createIssue(input) {
      const issueService = await loadIssueService();
      const assigneeAgentId = await ownerAgentId(db, input.companyId, input.ownerRole);
      if (!assigneeAgentId) {
        logger.warn(
          { companyId: input.companyId, ownerRole: input.ownerRole },
          "alert recovery task has no agent of the owner role yet; leaving it unassigned",
        );
      }
      try {
        const created = await issueService(db).create(input.companyId, {
          title: input.title,
          description: input.body,
          status: "todo",
          priority: input.priority,
          assigneeAgentId,
          originKind: ALERT_RECOVERY_ORIGIN_KIND,
          originId: input.originId,
          // The alert lifecycle is governed by the recovery journal, not by the
          // create-time title guard: the same trigger must open or join its own
          // task and never be merged into an unrelated one.
          allowDuplicate: true,
        } as never);
        if (!created) return null;
        return { id: created.id, identifier: created.identifier ?? null };
      } catch (error) {
        logger.warn({ err: error, originId: input.originId }, "alert recovery task refused");
        return null;
      }
    },

    async addComment(issueId, body) {
      try {
        const issueService = await loadIssueService();
        await issueService(db).addComment(issueId, body, {}, { authorType: "system" });
        return true;
      } catch (error) {
        logger.warn({ err: error, issueId }, "alert recovery comment refused");
        return false;
      }
    },

    closeIssue: (input) =>
      guardedWrite({
        issueId: input.issueId,
        companyId: input.companyId,
        guard: (current) => current.status !== "done" && current.status !== "cancelled",
        build: () => ({ status: "done" }),
        comment: input.body,
      }),

    reopenIssue: (input) =>
      guardedWrite({
        issueId: input.issueId,
        companyId: input.companyId,
        guard: (current) => current.status === "done" || current.status === "cancelled",
        build: () => ({ status: "todo" }),
        comment: input.body,
      }),
  };
}