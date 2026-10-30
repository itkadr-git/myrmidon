// myrmidon(BLOCKED-REASON): the blocked-patch for native failure paths
// (terminal session failure, permanent workspace failure). The unblock request
// goes to a senior AGENT through the same chain as review escalation
// (reports_to of the executor upward -> project lead -> agent `adm`); `board`
// only when the chain is empty. See services/review-escalation-chain.ts.
import { and, eq } from "drizzle-orm";
import { issues } from "@myrmidon/db";
import type { Db } from "@myrmidon/db";
import type { IssueUnblockDescriptor } from "@myrmidon/shared";
import { resolveDefaultEscalationAgentIds } from "../services/review-escalation-chain.js";
import { recoveryLivenessEventKey } from "./stale-block/event-keys.js";

export type EscalationChainResolver = (
  db: Db,
  issue: { companyId: string; projectId?: string | null; executionState?: unknown; assigneeAgentId?: string | null },
) => Promise<string[]>;

export function buildNativeFailureUnblockDescriptor(input: {
  issueId: string;
  ownerAgentId: string | null;
  action: string;
}): IssueUnblockDescriptor {
  return {
    owner: input.ownerAgentId ? { agentId: input.ownerAgentId } : "board",
    action: input.action,
    reasonRef: { kind: "event", eventKey: recoveryLivenessEventKey(input.issueId) },
  };
}

/** The `{ status: "blocked", unblockDescriptor }` patch for a native failure. */
export async function buildNativeFailureBlockedPatch(
  db: Db,
  input: { issueId: string; companyId: string; action: string },
  resolveChain: EscalationChainResolver = resolveDefaultEscalationAgentIds,
): Promise<{ status: "blocked"; unblockDescriptor: IssueUnblockDescriptor }> {
  const [issue] = await db
    .select({
      companyId: issues.companyId,
      projectId: issues.projectId,
      executionState: issues.executionState,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .limit(1);
  const chain = issue ? await resolveChain(db, issue) : [];
  return {
    status: "blocked",
    unblockDescriptor: buildNativeFailureUnblockDescriptor({
      issueId: input.issueId,
      ownerAgentId: chain[0] ?? null,
      action: input.action,
    }),
  };
}
