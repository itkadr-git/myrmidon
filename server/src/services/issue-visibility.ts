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
 * 1.7 PRIVATE-TASKS F4 regression guard: marks rows that maskPrivateNeighbour
 * stubbed as private. The marker is a non-enumerable symbol so JSON
 * serialization and deep-equality on response payloads never observe it; it
 * exists only so server-side authz re-filtering can recognize "the service
 * already decided this row's visibility" without re-deriving it from the
 * database (which breaks the stub contract once a gate re-loads the real row
 * by id).
 */
export const PRIVATE_NEIGHBOUR_STUB = Symbol("privateNeighbourStub");

/**
 * 1.7 PRIVATE-TASKS F4: replace a private neighbour row (parent, ancestor,
 * blocker, blocked issue, diagnostics node) with a stub before it reaches an
 * agent-facing response. `isPrivate` is always stripped from the output so
 * downstream truthy-flag filters cannot drop the stubbed row. Stubbed rows are
 * additionally tagged with the non-enumerable PRIVATE_NEIGHBOUR_STUB symbol.
 */
export function maskPrivateNeighbour<
  T extends { isPrivate?: boolean | null },
>(row: T): Omit<T, "isPrivate"> {
  const { isPrivate, ...rest } = row;
  if (!isPrivate) return rest as Omit<T, "isPrivate">;
  const stub = {
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
  // Non-enumerable: JSON.stringify, snapshot/deep equality, and the
  // `"isPrivate" in stub === false` contract tests must not observe the
  // marker. Spread copies drop it, which is safe: a copied stub still
  // serializes identically and route filters fall back to per-row decisions.
  Object.defineProperty(stub, PRIVATE_NEIGHBOUR_STUB, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return stub;
}
