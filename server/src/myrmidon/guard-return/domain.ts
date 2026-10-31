// server/src/myrmidon/guard-return/domain.ts
// 1.6.6 GUARD-RETURN (OPE-9962): Domain logic for guard-return sweep and assignee gates.
// Code tasks in dev projects must not stall on non-coding roles (reviewer, lead, operator).
// Automatically returns tasks with PR/changes_requested to the PR author or returnAssignee,
// puts them into in_progress, relays review remarks, and logs to activity_log.

import { normalizeLabels, requiresEngineer, isCheckoutRequiredPreference } from "../swarm-claim/requires-engineer.js";

export const GUARD_RETURN_ACTIVITY_ACTION = "myrmidon.guard_return.returned";
export const GUARD_RETURN_ALERT_KEY = "myrmidon_code_tasks_on_noncoding_roles";
export const DEFAULT_GUARD_RETURN_SWEEP_INTERVAL_SEC = 300; // 5 minutes
export const DEFAULT_NONCODING_ROLE_ALERT_THRESHOLD_MS = 30 * 60_000; // 30 minutes

export const NONCODING_ROLES = new Set(["reviewer", "lead", "operator", "pm", "qa", "adm", "general"]);

export interface PrWorkProductSummary {
  id: string;
  type: string;
  status: string;
  externalId?: string | null;
  createdByRunId?: string | null;
  creatorAgentId?: string | null;
  creatorRole?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CommentSummary {
  id: string;
  body: string;
  authorAgentId?: string | null;
  authorType?: string | null;
  createdAt: Date;
}

export interface GuardReturnCandidate {
  issueId: string;
  identifier: string | null;
  title: string;
  companyId: string;
  status: string;
  assigneeAgentId: string;
  assigneeRole: string;
  projectId: string | null;
  casteKey: string | null;
  labels: unknown;
  harnessKind?: string | null;
  executionWorkspacePreference?: string | null;
  executionState?: Record<string, unknown> | null;
  projectDefaultCasteKey?: string | null;
  prWorkProducts: PrWorkProductSummary[];
  comments: CommentSummary[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  status?: string;
}

export interface GuardReturnDecision {
  action: "return" | "skip";
  reason: string;
  targetAssigneeAgentId?: string;
  targetAssigneeName?: string;
  targetKind?: "pr_author" | "return_assignee" | "active_engineer";
  remarksText?: string | null;
  commentBody?: string;
}

/**
 * Returns true if the agent role has no coding rights (reviewer, lead, operator, or not engineer).
 */
export function isNoncodingRole(role: string | null | undefined): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  if (normalized === "engineer") return false;
  return NONCODING_ROLES.has(normalized) || true;
}

/**
 * Returns true if an issue belongs to a dev project or is a code issue.
 */
export function isDevProjectCodeIssue(input: {
  labels?: unknown;
  casteKey?: string | null;
  projectDefaultCasteKey?: string | null;
  projectName?: string | null;
  harnessKind?: string | null;
  executionWorkspacePreference?: string | null;
  prWorkProducts?: PrWorkProductSummary[];
  hasEngineerPr?: boolean;
  hasReviewState?: boolean;
}): boolean {
  const labelsList = normalizeLabels(input.labels ?? []);
  const isExplicitCode = requiresEngineer({
    labels: labelsList,
    casteKey: input.casteKey ?? null,
    projectDefaultCasteKey: input.projectDefaultCasteKey ?? null,
    harnessKind: input.harnessKind ?? null,
    executionWorkspacePreference: input.executionWorkspacePreference ?? null,
  });
  if (isExplicitCode) return true;

  if (input.hasEngineerPr) return true;

  // Having a pull_request work product indicates code work
  if (input.prWorkProducts && input.prWorkProducts.length > 0) {
    const hasPr = input.prWorkProducts.some(
      (p) => p.type === "pull_request",
    );
    if (hasPr) return true;
  }

  // Project default caste is engineer
  if (input.projectDefaultCasteKey?.toLowerCase() === "engineer") return true;

  return false;
}

/**
 * Checks if the candidate has a PR from an engineer.
 */
export function findEngineerPr(
  prProducts: PrWorkProductSummary[],
  agentMap: Map<string, AgentSummary>,
  runAgentMap?: Map<string, string>,
): { hasPr: boolean; authorAgentId: string | null } {
  for (const pr of prProducts) {
    if (pr.type !== "pull_request") continue;
    // Check creatorAgentId
    if (pr.creatorAgentId) {
      const agent = agentMap.get(pr.creatorAgentId);
      if (agent && agent.role === "engineer") {
        return { hasPr: true, authorAgentId: agent.id };
      }
    }
    // Check creatorRole if directly present
    if (pr.creatorRole === "engineer") {
      return { hasPr: true, authorAgentId: pr.creatorAgentId ?? null };
    }
    // Check createdByRunId
    if (pr.createdByRunId && runAgentMap) {
      const agentId = runAgentMap.get(pr.createdByRunId);
      if (agentId) {
        const agent = agentMap.get(agentId);
        if (agent && agent.role === "engineer") {
          return { hasPr: true, authorAgentId: agent.id };
        }
      }
    }
    // Check metadata author
    const meta = pr.metadata ?? {};
    const lastCommitAuthor = typeof meta.lastCommitAuthorAgentId === "string" ? meta.lastCommitAuthorAgentId : null;
    if (lastCommitAuthor) {
      const agent = agentMap.get(lastCommitAuthor);
      if (agent && agent.role === "engineer") {
        return { hasPr: true, authorAgentId: agent.id };
      }
    }
  }
  return { hasPr: false, authorAgentId: null };
}

/**
 * Checks if the last verdict was changes_requested.
 */
export function hasChangesRequestedVerdict(
  executionState: Record<string, unknown> | null | undefined,
): boolean {
  if (!executionState) return false;

  if (
    executionState.status === "changes_requested" ||
    executionState.lastDecisionOutcome === "changes_requested"
  ) {
    return true;
  }

  const stages = Array.isArray(executionState.stages)
    ? (executionState.stages as Array<Record<string, unknown>>)
    : [];
  const latestStage = stages[stages.length - 1];
  return Boolean(
    latestStage &&
      (latestStage.status === "changes_requested" ||
        latestStage.lastDecisionOutcome === "changes_requested"),
  );
}

/**
 * Extracts review remarks from comments or executionState.
 */
export function extractReviewRemarks(
  comments: CommentSummary[],
  executionState: Record<string, unknown> | null | undefined,
  reviewerAgentId?: string | null,
): string | null {
  // 1. Look for comments from reviewer or containing changes_requested, ignoring system comments
  for (const c of comments) {
    if (c.authorType === "system") continue;
    if (reviewerAgentId && c.authorAgentId === reviewerAgentId) {
      return c.body.trim();
    }
    const text = c.body.toLowerCase();
    if (
      text.includes("changes_requested") ||
      text.includes("request changes") ||
      text.includes("changes requested") ||
      text.includes("замечания")
    ) {
      return c.body.trim();
    }
  }

  // 2. Look at executionState decisionReason or reviewRemarks
  if (executionState) {
    if (typeof executionState.decisionReason === "string" && executionState.decisionReason.trim().length > 0) {
      return executionState.decisionReason.trim();
    }
    if (typeof executionState.reviewRemarks === "string" && executionState.reviewRemarks.trim().length > 0) {
      return executionState.reviewRemarks.trim();
    }
  }

  // 3. Fallback: most recent non-system comment if from another agent
  for (const c of comments) {
    if (c.authorType === "system") continue;
    if (c.body && c.body.trim().length > 0) {
      return c.body.trim();
    }
  }

  return null;
}

/**
 * Builds the guard-return comment body to post on the issue.
 */
export function buildGuardReturnComment(targetAgentName: string, remarksText: string | null): string {
  const header = `Задача возвращена автору (@${targetAgentName}) в статус in_progress (GUARD-RETURN: задача с кодом не должна оставаться на роли без права кода).`;
  if (!remarksText) {
    return header;
  }
  return `${header}\n\n### Замечания ревьюера:\n\n${remarksText}`;
}

/**
 * Builds the wake payload for the returned engineer agent.
 */
export function buildGuardReturnWakePayload(issueId: string, remarksText: string | null): Record<string, unknown> {
  return {
    issueId,
    intent: "guard_return",
    remarks: remarksText,
    source: "myrmidon.guard_return",
  };
}

/**
 * Evaluates candidate against guard-return rules and decides whether to return.
 */
export function decideGuardReturn(
  candidate: GuardReturnCandidate,
  agentMap: Map<string, AgentSummary>,
  runAgentMap?: Map<string, string>,
  activeEngineers?: AgentSummary[],
): GuardReturnDecision {
  // Check if status is in_progress or in_review
  if (candidate.status !== "in_progress" && candidate.status !== "in_review") {
    return { action: "skip", reason: `Status ${candidate.status} is not in_progress or in_review` };
  }

  const isPendingReviewStage =
    candidate.status === "in_review" &&
    candidate.executionState?.currentStageType === "review" &&
    (candidate.executionState.status === "pending" ||
      (candidate.executionState.currentParticipant as Record<string, unknown> | undefined)?.type === "agent" &&
        (candidate.executionState.currentParticipant as Record<string, unknown>).agentId === candidate.assigneeAgentId);
  if (isPendingReviewStage) {
    return { action: "skip", reason: "Review stage is pending for its current participant" };
  }

  // Check if current assignee is a non-coding role
  if (!isNoncodingRole(candidate.assigneeRole)) {
    return { action: "skip", reason: `Assignee role ${candidate.assigneeRole} is not a non-coding role` };
  }

  // Check qualification: has PR from engineer OR last verdict is changes_requested
  const { hasPr, authorAgentId: prAuthorId } = findEngineerPr(candidate.prWorkProducts, agentMap, runAgentMap);
  const isChangesRequested = hasChangesRequestedVerdict(candidate.executionState);

  // Check if issue is a dev-project code issue
  const isCode = isDevProjectCodeIssue({
    labels: candidate.labels,
    casteKey: candidate.casteKey,
    projectDefaultCasteKey: candidate.projectDefaultCasteKey,
    harnessKind: candidate.harnessKind,
    executionWorkspacePreference: candidate.executionWorkspacePreference,
    hasEngineerPr: hasPr,
  });
  if (!isCode) {
    return { action: "skip", reason: "Issue is not a dev-project code task" };
  }

  if (!hasPr && !isChangesRequested) {
    return {
      action: "skip",
      reason: "No engineer PR and last verdict is not changes_requested",
    };
  }

  // Resolve target engineer to return to
  // Priority 1: PR author / committer
  let targetAssigneeAgentId: string | null = prAuthorId;
  let targetKind: "pr_author" | "return_assignee" | "active_engineer" = "pr_author";

  // Priority 2: returnAssignee from executionState
  if (!targetAssigneeAgentId && candidate.executionState) {
    const returnAssignee = candidate.executionState.returnAssignee as Record<string, unknown> | undefined;
    if (returnAssignee && returnAssignee.type === "agent" && typeof returnAssignee.agentId === "string") {
      const returnAgent = agentMap.get(returnAssignee.agentId);
      if (returnAgent && returnAgent.role === "engineer") {
        targetAssigneeAgentId = returnAgent.id;
        targetKind = "return_assignee";
      }
    }
  }

  // Priority 3: any active engineer in the company
  if (!targetAssigneeAgentId && activeEngineers && activeEngineers.length > 0) {
    targetAssigneeAgentId = activeEngineers[0].id;
    targetKind = "active_engineer";
  }

  if (!targetAssigneeAgentId) {
    return {
      action: "skip",
      reason: "Could not find a valid engineer to return the task to",
    };
  }

  const targetAgent = agentMap.get(targetAssigneeAgentId) ?? activeEngineers?.find((a) => a.id === targetAssigneeAgentId);
  const targetAgentName = targetAgent?.name ?? targetAssigneeAgentId;
  const remarksText = extractReviewRemarks(candidate.comments, candidate.executionState, candidate.assigneeAgentId);
  const commentBody = buildGuardReturnComment(targetAgentName, remarksText);

  return {
    action: "return",
    reason: `Returning code task to ${targetKind} (${targetAgentName}) with status in_progress`,
    targetAssigneeAgentId,
    targetAssigneeName: targetAgentName,
    targetKind,
    remarksText,
    commentBody,
  };
}
