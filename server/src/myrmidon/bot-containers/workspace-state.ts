// myrmidon(1.6.5-BOT-DISK-H4a): the pure lifecycle rule of one bot task copy.
//
// `GET /api/myrmidon/bots/me/workspaces` (contract C3) tells botd which task
// copies of a bot should exist (`active`) and which should be removed
// (`closing`). This file is the whole rule and nothing else: no database, no
// clock, no network, so the table of cases is a plain unit test.

import type { WsDesiredPrState, WsDesiredWorkspaceState } from "@paperclipai/shared";

/** Statuses after which the task needs no copy. */
export const WORKSPACE_TERMINAL_ISSUE_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);

export interface WorkspaceIssueFacts {
  status: string;
  /** Current assignee of the task (null when unassigned). */
  assigneeAgentId: string | null;
  /** The bot the list is built for. */
  botAgentId: string;
  /** Hidden (archived) tasks have no copy. */
  hidden?: boolean;
}

/**
 * One pull request of the task as the task-pr-sync stores it (work product
 * status refreshed from the GitHub resolver): `resolvedPullRequestState`.
 * `draft` counts as open, an unknown or superseded product is left out.
 */
export interface WorkspacePrFact {
  state: "open" | "draft" | "merged" | "closed" | "unknown" | "superseded";
}

/**
 * Collapse the task's pull requests into the contract's `prState`.
 * A copy is only safe to drop on `merged` when no other PR of the task is
 * still open, so an open PR wins over a merged one.
 */
export function prStateOf(prFacts: readonly WorkspacePrFact[]): WsDesiredPrState {
  const states = new Set(prFacts.map((pr) => pr.state));
  if (states.has("open") || states.has("draft")) return "open";
  if (states.has("merged")) return "merged";
  if (states.has("closed")) return "closed";
  return "none";
}

export interface WorkspaceStateResult {
  state: WsDesiredWorkspaceState;
  prState: WsDesiredPrState;
  /** Why the copy is closing (absent for active); informational, not in the contract payload. */
  reason?: "terminal" | "hidden" | "reassigned" | "pr_merged";
}

/**
 * active  — assigned to this bot and not terminal (in_progress, blocked,
 *           in_review, awaiting approval, todo, backlog).
 * closing — done / cancelled / hidden, reassigned to someone else, or the
 *           task's pull request is merged (the task-pr-sync settles it, but a
 *           merged PR closes the copy even before the status moves).
 */
export function workspaceStateOf(
  issue: WorkspaceIssueFacts,
  prFacts: readonly WorkspacePrFact[],
): WorkspaceStateResult {
  const prState = prStateOf(prFacts);
  if (issue.hidden) return { state: "closing", prState, reason: "hidden" };
  if (WORKSPACE_TERMINAL_ISSUE_STATUSES.has(issue.status)) return { state: "closing", prState, reason: "terminal" };
  if (issue.assigneeAgentId !== issue.botAgentId) return { state: "closing", prState, reason: "reassigned" };
  if (prState === "merged") return { state: "closing", prState, reason: "pr_merged" };
  return { state: "active", prState };
}
