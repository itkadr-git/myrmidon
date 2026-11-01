import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  interactionEscalations,
  issueThreadInteractions,
  type Db,
} from "@myrmidon/db";
import { interactionEscalationStepSchema, type InteractionRecipient } from "@myrmidon/shared/interaction-routing";

export type EscalationStepResult = "escalated" | "unchanged";

/** Advance exactly one pending card level, recording the handoff and wake atomically. */
export async function escalateInteractionStep(
  db: Db,
  interactionId: string,
  level: number,
): Promise<EscalationStepResult> {
  if (!Number.isSafeInteger(level) || level < 1) throw new Error("Invalid escalation level");
  return db.transaction(async (tx) => {
    const [card] = await tx.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId)).for("update");
    if (!card) throw new Error("Interaction not found");
    if (card.status !== "pending" || level <= card.escalationLevel) return "unchanged";
    if (level !== card.escalationLevel + 1) throw new Error("Escalation must advance one level");

    const parsed = interactionEscalationStepSchema.array().min(1).safeParse(card.escalationChain);
    if (!parsed.success || parsed.data.length < 2) throw new Error("Invalid escalation chain");
    const chain = parsed.data;
    if (level >= chain.length) return "unchanged";
    const terminal = chain[chain.length - 1]?.recipient;
    if (!terminal || !("serviceQueue" in terminal)) throw new Error("Escalation chain must end in a service queue");
    const next = chain[level]?.recipient;
    if (!next || (card.routeType === "code_review" && "userId" in next)) {
      throw new Error("Invalid escalation recipient");
    }
    const from: InteractionRecipient | null = card.addresseeAgentId
      ? { agentId: card.addresseeAgentId }
      : card.addresseeUserId ? { userId: card.addresseeUserId }
        : card.addresseeQueue ? { serviceQueue: card.addresseeQueue } : null;
    if (!from) throw new Error("Card has no current addressee");
    const nextDelay = chain[level + 1]?.afterMinutes;
    const now = new Date();
    const timeoutAt = nextDelay === undefined
      ? new Date("9999-12-31T23:59:59.000Z")
      : new Date(now.getTime() + Math.max(0, nextDelay - chain[level]!.afterMinutes) * 60_000);
    await tx.update(issueThreadInteractions).set({
      addresseeAgentId: "agentId" in next ? next.agentId : null,
      addresseeUserId: "userId" in next ? next.userId : null,
      addresseeQueue: "serviceQueue" in next ? next.serviceQueue : null,
      escalationLevel: level,
      timeoutAt,
      updatedAt: now,
    }).where(eq(issueThreadInteractions.id, interactionId));
    await tx.insert(interactionEscalations).values({
      companyId: card.companyId,
      interactionId,
      level,
      fromRecipient: from,
      toRecipient: next,
      reason: "timeout",
    }).onConflictDoNothing();
    if ("agentId" in next) {
      await tx.insert(agentWakeupRequests).values({
        companyId: card.companyId,
        agentId: next.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "interaction_pending",
        status: "queued",
        idempotencyKey: `interaction-pending:${interactionId}:level:${level}`,
        requestedByActorType: "system",
        requestedByActorId: "interaction-escalation",
        payload: {
          issueId: card.issueId,
          interactionId,
          interactionKind: card.kind,
          sourceCommentId: card.sourceCommentId,
          sourceRunId: card.sourceRunId,
          mutation: "interaction",
          escalationLevel: level,
          escalationWake: {
            wakeIdempotencyKey: `interaction-pending:${interactionId}:level:${level}`,
            contextSnapshot: { issueId: card.issueId, taskId: card.issueId,
              interactionId, interactionKind: card.kind, escalationLevel: level,
              wakeReason: "interaction_pending", source: "issue.interaction.escalated" },
          },
        },
      });
    }
    return "escalated";
  });
}
