// myrmidon(1.6-AUTONOMY): decide a held autonomy action.
//
// A held autonomy action is not a gateway tool: it has no connection, no catalog
// entry and no signed arguments, so the tool conveyor cannot carry it — the
// gateway's own approver cancels a request it cannot verify against a signature.
// This function is the decision entry for our holds: it checks the request is
// ours and then hands the decision to the shared review transaction, which owns
// the status bookkeeping, the optimistic guard and the replay of the action
// (see the `myrmidon(1.6-AUTONOMY)` hook in `services/tool-action-review.ts`).

import { and, eq } from "drizzle-orm";
import { toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";
import { commitToolActionReview } from "../../services/tool-action-review.js";
import { isAutonomyToolName } from "./action-execution.js";

export interface DecideHeldAutonomyActionInput {
  db: Db;
  companyId: string;
  actionRequestId: string;
  decision: "approved" | "rejected";
  /** The deciding actor. Agents are refused by the shared review transaction. */
  actor: { userId: string | null; agentId?: string | null };
  reason?: string;
}

export type HeldAutonomyDecision =
  | { kind: "decided"; status: string }
  | { kind: "not_autonomy" }
  | { kind: "not_found" };

/**
 * Approve or reject a held autonomy action. `not_autonomy` means the request
 * belongs to the ordinary tool conveyor and must be decided there.
 */
export async function decideHeldAutonomyAction(
  input: DecideHeldAutonomyActionInput,
): Promise<HeldAutonomyDecision> {
  const [request] = await input.db
    .select()
    .from(toolActionRequests)
    .where(
      and(
        eq(toolActionRequests.id, input.actionRequestId),
        eq(toolActionRequests.companyId, input.companyId),
      ),
    )
    .limit(1);
  if (!request) return { kind: "not_found" };

  const [invocation] = await input.db
    .select({ toolName: toolInvocations.toolName })
    .from(toolInvocations)
    .where(eq(toolInvocations.id, request.invocationId))
    .limit(1);
  if (!invocation || !isAutonomyToolName(invocation.toolName)) {
    return { kind: "not_autonomy" };
  }

  const decided = await commitToolActionReview(input.db, {
    companyId: input.companyId,
    actionRequestId: input.actionRequestId,
    decision: input.decision,
    actor: { userId: input.actor.userId, agentId: input.actor.agentId ?? null },
    reason: input.reason,
  });
  // The review transaction returns the row as it was written; the replay of an
  // approved hold settles it to `executed`/`failed` just after, so report what
  // the row actually says once the decision (and any replay) is done.
  const [settled] = await input.db
    .select({ status: toolActionRequests.status })
    .from(toolActionRequests)
    .where(eq(toolActionRequests.id, input.actionRequestId))
    .limit(1);
  return { kind: "decided", status: settled?.status ?? decided.status };
}