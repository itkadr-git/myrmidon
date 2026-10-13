// myrmidon(REPLAY-BLOCK-TRIAGE): the attention-feed card for a task locked by
// a settled "do not replay" hold ("Replay blocked"). Until this, the backlog
// grew silently: 160 held tasks on 09.10, 36 of them in todo/in_progress/
// in_review with no run and nobody notified — the only surface was the "Review
// and clear" button on the task card itself (ui/src/components/myrmidon/
// ReplayBlocked.tsx), and the recovery resolve API refused once the assignee
// changed (OPE-6329).
//
// One card per locked task, computed live from the same recovery rows the
// dispatcher reads, so it exists exactly while the hold locks the task and
// disappears after Restore / Done / Cancel / a cleared hold. The responsible is
// the assignee agent's manager (`agents.reportsTo`), else the board operator
// (companies.defaultResponsibleUserId); the card names them and carries the
// hold age so the overdue ones read as overdue. The dedup key rotates per UTC
// day: a dismissal silences the card for that day only, and it re-surfaces the
// next day until the hold is actually triaged.
// See docs/myrmidon/DIVERGENCE.md "REPLAY-BLOCK-TRIAGE".

import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  agents,
  companies,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import { executionBlockerPredicate } from "../../services/execution-blocker.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReplayLockedCard {
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueStatus: string;
  recoveryActionId: string;
  cause: string;
  assigneeAgentId: string | null;
  /** Agent id of the assignee's manager, when the assignee has one. */
  managerAgentId: string | null;
  managerAgentName: string | null;
  /** Board operator user id used as responsible when there is no manager. */
  operatorUserId: string | null;
  /** When the hold was settled (its last update). */
  heldAt: string;
  heldMs: number;
  /** The triage deadline shown on the card: hold + 24h. */
  dueAt: string;
  /** UTC day stamped into the dedup key (daily re-surface). */
  dayKey: string;
}

/**
 * One card per non-closed task whose newest effective blocker is a settled
 * no-replay hold. Unassigned tasks are included — the whole point of the task
 * is that a locked task without a working run must not sit silently; the
 * responsible is then the board operator directly.
 */
export async function listReplayLockedCards(
  db: Db,
  companyId: string,
  nowMs: number = Date.now(),
): Promise<ReplayLockedCard[]> {
  const actions = await db
    .select({
      id: issueRecoveryActions.id,
      sourceIssueId: issueRecoveryActions.sourceIssueId,
      cause: issueRecoveryActions.cause,
      updatedAt: issueRecoveryActions.updatedAt,
    })
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, companyId),
        executionBlockerPredicate(),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
        // Active/escalated actions already carry the vendor recovery card.
        notInArray(issueRecoveryActions.status, ["active", "escalated"]),
      ),
    )
    .orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id));
  if (!actions.length) return [];

  // Newest settled hold per issue wins (the dispatcher reads the newest too).
  const byIssue = new Map<(typeof actions)[number]["sourceIssueId"], (typeof actions)[number]>();
  for (const action of actions) {
    if (!byIssue.has(action.sourceIssueId)) byIssue.set(action.sourceIssueId, action);
  }

  const issueRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeAgentName: agents.name,
      assigneeReportsTo: agents.reportsTo,
      managerAgentName: sql<string | null>`(select m.name from agents m where m.id = ${agents.reportsTo})`,
    })
    .from(issues)
    .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, [...byIssue.keys()]),
        notInArray(issues.status, ["done", "cancelled"]),
        sql`${issues.hiddenAt} is null`,
      ),
    );
  if (!issueRows.length) return [];

  const [company] = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const dayKey = new Date(nowMs).toISOString().slice(0, 10);
  const cards: ReplayLockedCard[] = [];
  for (const issue of issueRows) {
    const action = byIssue.get(issue.id)!;
    const heldMs = Math.max(0, nowMs - action.updatedAt.getTime());
    cards.push({
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? null,
      issueTitle: issue.title ?? null,
      issueStatus: issue.status,
      recoveryActionId: action.id,
      cause: action.cause,
      assigneeAgentId: issue.assigneeAgentId ?? null,
      managerAgentId: issue.assigneeReportsTo ?? null,
      managerAgentName: issue.managerAgentName ?? null,
      operatorUserId: company?.defaultResponsibleUserId ?? null,
      heldAt: action.updatedAt.toISOString(),
      heldMs,
      dueAt: new Date(action.updatedAt.getTime() + DAY_MS).toISOString(),
      dayKey,
    });
  }
  return cards;
}

export function replayLockedDedupKey(card: ReplayLockedCard): string {
  return `replay-locked:${card.issueId}:${card.recoveryActionId}:${card.dayKey}`;
}

/** Named responsible: the assignee's manager, else the board operator. */
export function replayLockedResponsible(card: ReplayLockedCard): {
  label: string;
  kind: "agent" | "user";
  id: string | null;
} {
  if (card.managerAgentId && card.managerAgentName) {
    return { label: card.managerAgentName, kind: "agent", id: card.managerAgentId };
  }
  if (card.operatorUserId) {
    return { label: "Board operator", kind: "user", id: card.operatorUserId };
  }
  return { label: "Board operator", kind: "user", id: null };
}

export function replayLockedWhyNow(card: ReplayLockedCard): string {
  const responsible = replayLockedResponsible(card);
  const heldHours = Math.floor(card.heldMs / 3_600_000);
  const overdue = card.heldMs > DAY_MS;
  return overdue
    ? `Replay-blocked for ${heldHours}h (past the ${"24h"} triage deadline); ${responsible.label} must clear or restore it.`
    : `Replay-blocked for ${heldHours}h; ${responsible.label} must triage it by ${card.dueAt.slice(0, 16)}Z.`;
}

export function replayLockedDetail(card: ReplayLockedCard): string {
  const responsible = replayLockedResponsible(card);
  return [
    `cause=${card.cause}`,
    `hold settled at ${card.heldAt}`,
    `triage deadline ${card.dueAt}`,
    `responsible=${responsible.kind}:${responsible.label}${responsible.id ? ` (${responsible.id})` : ""}`,
  ].join("; ");
}

export function replayLockedSeverity(card: ReplayLockedCard): "high" | "medium" {
  return card.heldMs > DAY_MS ? "high" : "medium";
}
