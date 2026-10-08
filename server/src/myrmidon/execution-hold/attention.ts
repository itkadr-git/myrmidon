// myrmidon(OPE-6011): the attention-feed card for a task whose run is held
// by a settled execution-reconciliation hold ("execution_reconciliation_required").
// Until this, the hold had no operator-visible surface: every wake of the
// assignee went to `skipped` with no card, no button, and no way out short
// of creating a new task (the OPE-5851 failure mode on 08.10).
//
// The card is computed on the fly from the live blocker
// (services/execution-blocker.ts's `getExecutionBlocker`), the same query
// the dispatcher itself applies, so it exists exactly while the hold
// blocks, and disappears the moment the hold is superseded (an explicit
// wake, a recovery resolution, or the confirm-continue action in
// routes/issues.ts). The Confirm verb calls that endpoint — the person
// attests the failed run left no external side effects, the hold is
// superseded and the assignee is woken with an explicit wake.

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  EXECUTION_RECONCILIATION_CAUSES,
  type AttentionSeverity,
} from "@paperclipai/shared";
import { issueRecoveryActions, issues, type Db } from "@paperclipai/db";

export interface ExecutionHoldCardInput {
  actionId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueStatus: string;
  cause: string;
  failedRunId: string | null;
  nextAction: string | null;
  activityAt: string;
}

/**
 * Lists one card per issue whose newest effective blocker is a settled
 * "do not replay" execution-reconciliation hold — the exact population
 * whose wakes the dispatcher skips with `execution_reconciliation_required`.
 * Only issues with a live assignee are listed (an unassigned task has no
 * executor to wake; the hold is the board's to clear by assigning first).
 * A genuinely still-open action (status active/escalated) already has its
 * own `recovery_action` card and its own resolve flow, so it is excluded
 * here.
 */
export async function listExecutionHoldCards(
  db: Db,
  companyId: string,
): Promise<ExecutionHoldCardInput[]> {
  const actions = await db
    .select({
      id: issueRecoveryActions.id,
      sourceIssueId: issueRecoveryActions.sourceIssueId,
      cause: issueRecoveryActions.cause,
      nextAction: issueRecoveryActions.nextAction,
      evidence: issueRecoveryActions.evidence,
      updatedAt: issueRecoveryActions.updatedAt,
    })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, companyId),
        inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
        inArray(issueRecoveryActions.status, ["resolved", "cancelled"]),
      ),
    )
    .orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id));
  if (!actions.length) return [];

  const replayBlocked = actions.filter((action) => {
    const automaticRecovery = (action.evidence as Record<string, unknown> | null)?.automaticRecovery as
      | Record<string, unknown>
      | undefined;
    return automaticRecovery?.replay === "blocked";
  });
  if (!replayBlocked.length) return [];

  const issueIds = [...new Set(replayBlocked.map((action) => action.sourceIssueId))];
  const issueRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .where(and(inArray(issues.id, issueIds), eq(issues.companyId, companyId)));
  const issueById = new Map(issueRows.map((row) => [row.id, row]));

  // Newest effective blocker per issue wins (the dispatcher's non-explicit
  // read also takes the newest matching action only).
  const byIssue = new Map<string, (typeof replayBlocked)[number]>();
  for (const action of replayBlocked) {
    if (!byIssue.has(action.sourceIssueId)) byIssue.set(action.sourceIssueId, action);
  }

  const cards: ExecutionHoldCardInput[] = [];
  for (const action of byIssue.values()) {
    const issue = issueById.get(action.sourceIssueId);
    if (!issue || issue.assigneeAgentId == null) continue;
    const evidence = (action.evidence ?? {}) as Record<string, unknown>;
    const runIdRaw = evidence.runId ?? evidence.sourceRunId;
    const failedRunId = typeof runIdRaw === "string" && runIdRaw.length > 0 ? runIdRaw : null;
    cards.push({
      actionId: action.id,
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? null,
      issueTitle: issue.title ?? null,
      issueStatus: issue.status,
      cause: action.cause,
      failedRunId,
      nextAction: action.nextAction ?? null,
      activityAt: action.updatedAt.toISOString(),
    });
  }
  return cards;
}

export function executionHoldSignalDedupKey(card: ExecutionHoldCardInput): string {
  return `execution-hold:${card.issueId}:${card.actionId}`;
}

export function executionHoldSignalSeverity(): AttentionSeverity {
  return "high";
}

export function executionHoldSignalWhyNow(card: ExecutionHoldCardInput): string {
  const cause = card.cause.replaceAll("_", " ");
  return `A run of this task's assignee failed (${cause}) and its external actions could not be confirmed. Every wake of the assignee is held until a person confirms there was no external action — the task is silently stuck otherwise.`;
}

export function executionHoldSignalDetail(card: ExecutionHoldCardInput): string {
  const parts = [
    card.nextAction,
    card.failedRunId ? `Failed run: ${card.failedRunId}.` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}
