// myrmidon(HANDOFF-CAS): guarded agent-to-agent task handoff for the general
// PATCH /api/issues/{id} path, ported from the vendor native-runtime
// reassignment mechanics (paperclipai/paperclip#13686, commit d82fbb0f).
// The vendor semantic runner tool is NOT ported — only the server-side CAS,
// commit-in-transaction, receipt, and guarded-rollback mechanics.
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { HttpError, conflict } from "../errors.js";
import { logActivity, type ActivityPublication } from "../services/activity-log.js";

export const HANDOFF_RECEIPT_ACTION = "issue.reassigned";
export const HANDOFF_LIVE_RUN_STATUSES = ["running", "queued", "scheduled_retry"] as const;

export type HandoffExpected = {
  expectedAssigneeAgentId: string | null;
  expectedStatusVersion: number;
};

export type HandoffInput = {
  issueId: string;
  companyId: string;
  commandId: string;
  actorAgentId: string | null;
  actorUserId: string | null;
  expected: HandoffExpected;
  nextAssigneeAgentId: string | null;
  nextAssigneeUserId: string | null;
  reason: string | null;
};

export type HandoffReceiptDetails = {
  commandId: string;
  fingerprint: string;
  disposition: "applied" | "duplicate" | "conflict" | "rollback";
  stateRevision: number;
  scheduledWakeKeys: string[];
  expectedAssigneeAgentId: string | null;
  expectedStatusVersion: number;
  fromAssigneeAgentId: string | null;
  toAssigneeAgentId: string | null;
  reason: string | null;
  interruptedRunId: string | null;
  rollbackError?: string;
};

// sha256 over the normalized handoff inputs. Two requests with the same
// commandId and the same fingerprint are replays; the same commandId with a
// different fingerprint is an idempotency conflict.
export function buildHandoffFingerprint(input: {
  issueId: string;
  expectedAssigneeAgentId: string | null;
  expectedStatusVersion: number;
  nextAssigneeAgentId: string | null;
  nextAssigneeUserId: string | null;
  reason: string | null;
}): string {
  const canonical = JSON.stringify([
    input.issueId,
    input.expectedAssigneeAgentId ?? null,
    input.expectedStatusVersion,
    input.nextAssigneeAgentId ?? null,
    input.nextAssigneeUserId ?? null,
    input.reason ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function handoffNewOwnerWakeKey(commandId: string, issueId: string): string {
  return `handoff:${commandId}:owner:${issueId}`;
}

export function handoffRollbackWakeKey(commandId: string, issueId: string): string {
  return `handoff:${commandId}:rollback:${issueId}`;
}

// Compare the locked row against the caller's expectations. Returns the
// mismatch reason, or null when the CAS holds.
export function handoffCasMismatch(
  locked: {
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    statusVersion: number;
  },
  expected: HandoffExpected,
  target: { nextAssigneeAgentId: string | null; nextAssigneeUserId: string | null },
): string | null {
  if (target.nextAssigneeUserId !== locked.assigneeUserId) {
    // A guarded handoff transfers agent ownership only; changing the user
    // assignment under an owner/version expectation is always a mismatch.
    return "user_assignment";
  }
  if (locked.assigneeAgentId !== expected.expectedAssigneeAgentId) {
    return "assignee_owner";
  }
  if (locked.statusVersion !== expected.expectedStatusVersion) {
    return "status_version";
  }
  return null;
}

export function handoffCasConflict(mismatch: string, issueId: string): HttpError {
  return conflict(
    "The issue changed since the handoff expectation was taken; the handoff was not committed",
    { code: "issue_reassignment_conflict", mismatch, issueId },
  );
}

export type HandoffLockedRow = {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  statusVersion: number;
  executionRunId: string | null;
  checkoutRunId: string | null;
  conversationAgentId: string | null;
  executionState: unknown;
};

// Live-run guard for the commit phase: after the old owner's run was stopped
// under confirmation, no run may have started (or been queued/retried) for
// the issue or its current assignee before the commit lands.
export async function findHandoffLiveRun(
  dbOrTx: Db | any,
  row: {
    id: string;
    companyId: string;
    assigneeAgentId: string | null;
    executionRunId: string | null;
  },
): Promise<{ id: string; status: string } | null> {
  const directIds = [row.executionRunId].filter(
    (value): value is string => typeof value === "string",
  );
  const byId = directIds.length
    ? dbOrTx
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(
          and(
            inArray(heartbeatRuns.id, directIds),
            inArray(heartbeatRuns.status, [...HANDOFF_LIVE_RUN_STATUSES]),
          ),
        )
        .limit(1)
        .then((rows: Array<{ id: string; status: string }>) => rows[0] ?? null)
    : Promise.resolve(null);

  const byAgent = row.assigneeAgentId
    ? dbOrTx
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, row.companyId),
            eq(heartbeatRuns.agentId, row.assigneeAgentId),
            inArray(heartbeatRuns.status, [...HANDOFF_LIVE_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${row.id}`,
          ),
        )
        .limit(1)
        .then((rows: Array<{ id: string; status: string }>) => rows[0] ?? null)
    : Promise.resolve(null);

  const [a, b] = await Promise.all([byId, byAgent]);
  return a ?? b;
}

// Pre-check without a lock (cheap, before the stop phase): find a prior
// receipt for this issue with the same commandId. The query rides the
// existing company/activity indexes; no new index or migration is added.
export async function findHandoffReceiptByCommand(
  dbOrTx: Db | any,
  input: { companyId: string; issueId: string; commandId: string },
): Promise<HandoffReceiptDetails | null> {
  const row = await dbOrTx
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.action, HANDOFF_RECEIPT_ACTION),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        sql`${activityLog.details} ->> 'commandId' = ${input.commandId}`,
      ),
    )
    .orderBy(sql`${activityLog.createdAt} desc`)
    .limit(1)
    .then((rows: Array<{ details: Record<string, unknown> | null }>) => rows[0] ?? null);
  if (!row?.details) return null;
  return row.details as unknown as HandoffReceiptDetails;
}

export async function insertHandoffReceipt(
  dbOrTx: Db | any,
  input: {
    companyId: string;
    issueId: string;
    actorType: "user" | "agent" | "system" | "board";
    actorId: string;
    agentId: string | null;
    runId: string | null;
    agentApiKeyId?: string | null;
    details: HandoffReceiptDetails;
    postCommitActivityPublications?: ActivityPublication[];
  },
): Promise<void> {
  await logActivity(
    dbOrTx as Db,
    {
      companyId: input.companyId,
      // logActivity's contract has no "board" actor yet; the board operator's
      // identity stays in actorId and the receipt details.
      actorType: input.actorType === "board" ? "system" : input.actorType,
      actorId: input.actorId,
      agentId: input.agentId,
      runId: input.runId,
      agentApiKeyId: input.agentApiKeyId ?? null,
      action: HANDOFF_RECEIPT_ACTION,
      entityType: "issue",
      entityId: input.issueId,
      details: { ...input.details } as unknown as Record<string, unknown>,
    },
    input.postCommitActivityPublications,
  );
}

// Lock the row and re-check everything the commit depends on, in one
// transaction: CAS, the stopped-run fence (executionRunId unchanged and no
// live run), and the no-owner-left-behind invariant.
export async function assertHandoffCommitAllowed(
  dbOrTx: Db | any,
  input: {
    issueId: string;
    companyId: string;
    expected: HandoffExpected;
    nextAssigneeAgentId: string | null;
    nextAssigneeUserId: string | null;
    stopConfirmed: boolean;
    executionRunIdAtPreparation: string | null;
  },
): Promise<{ locked: HandoffLockedRow; mismatch?: string; liveRun?: { id: string; status: string } | null }> {
  const locked = (await dbOrTx
    .select()
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .for("update")
    .then((rows: Array<HandoffLockedRow>) => rows[0] ?? null)) as HandoffLockedRow | null;
  if (!locked) {
    throw conflict("Issue not found", { code: "issue_reassignment_conflict", issueId: input.issueId });
  }
  // Live-run fence: no running/queued/scheduled_retry run may exist for the
  // issue's previous owner at commit time. A cancelled/failed run left behind
  // by the confirmed stop does not count as live.
  const liveRun = await findHandoffLiveRun(dbOrTx, locked);
  if (liveRun) {
    if (!input.stopConfirmed) {
      throw conflict(
        "The previous owner's run was not stopped under confirmation before commit",
        { code: "reassignment_stop_unconfirmed", runId: liveRun.id },
      );
    }
    throw conflict(
      "A new run for the previous owner started between the stop and the commit",
      { code: "reassignment_stop_unconfirmed", runId: liveRun.id },
    );
  }
  // executionRunId fence: the stop may clear the pointer (cancelRun sets it to
  // null), but no *different* run may have claimed the issue since preparation.
  if (
    locked.executionRunId !== null &&
    locked.executionRunId !== (input.executionRunIdAtPreparation ?? null)
  ) {
    throw conflict(
      "A new run for the previous owner started between the stop and the commit",
      {
        code: "reassignment_stop_unconfirmed",
        runId: locked.executionRunId,
      },
    );
  }
  const mismatch = handoffCasMismatch(locked, input.expected, {
    nextAssigneeAgentId: input.nextAssigneeAgentId,
    nextAssigneeUserId: input.nextAssigneeUserId,
  });
  if (mismatch) throw handoffCasConflict(mismatch, locked.id);
  return { locked, mismatch, liveRun: null };
}

// Bump statusVersion with the handoff commit so the new owner and any guard
// observe a fresh revision. Returns the new revision.
export async function bumpHandoffStatusVersion(
  dbOrTx: Db | any,
  issueId: string,
): Promise<number> {
  const updated = await dbOrTx
    .update(issues)
    .set({ statusVersion: sql`${issues.statusVersion} + 1` })
    .where(eq(issues.id, issueId))
    .returning({ statusVersion: issues.statusVersion })
    .then((rows: Array<{ statusVersion: number }>) => rows[0] ?? null);
  return updated?.statusVersion ?? 0;
}

// The forbidden-state gate shared by the pre-lock check and diagnostics.
export function handoffForbiddenStateReason(row: {
  status: string;
  conversationAgentId?: string | null;
  pendingExecutionStage?: boolean;
}): string | null {
  if (row.status === "in_review") return "in_review";
  if (row.status === "done") return "done";
  if (row.status === "cancelled") return "cancelled";
  if (row.conversationAgentId) return "conversation_issue";
  if (row.pendingExecutionStage) return "pending_execution_stage";
  return null;
}
