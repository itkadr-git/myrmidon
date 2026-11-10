import { and, isNull, type SQL } from "drizzle-orm";
import { issues } from "@myrmidon/db";

export function visibleIssueCondition(): SQL {
  return and(isNull(issues.hiddenAt), isNull(issues.harnessKind))!;
}

export function visibleIssueSql(alias = "issues") {
  return `"${alias}"."hidden_at" IS NULL AND "${alias}"."harness_kind" IS NULL`;
}

/** Work queues and execution totals omit persistent conversation containers. */
export function executionIssueCondition(): SQL {
  return and(visibleIssueCondition(), isNull(issues.conversationAgentId))!;
}

/**
 * 1.7 PRIVATE-TASKS F4: replace a private neighbour row (parent, ancestor,
 * blocker, blocked issue, diagnostics node) with a stub before it reaches an
 * agent-facing response. `isPrivate` is always stripped from the output so
 * downstream truthy-flag filters cannot drop the stubbed row.
 */
export function maskPrivateNeighbour<
  T extends { isPrivate?: boolean | null },
>(row: T): Omit<T, "isPrivate"> {
  const { isPrivate, ...rest } = row;
  if (!isPrivate) return rest as Omit<T, "isPrivate">;
  return {
    ...rest,
    identifier: null,
    title: "Private task",
    description: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    projectId: null,
    goalId: null,
    blockerMetadata: null,
  } as Omit<T, "isPrivate">;
}
