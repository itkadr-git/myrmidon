import { and, asc, eq, isNotNull, lte, notExists, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { interactionEscalations, issueThreadInteractions } from "@myrmidon/db";

export interface DueEscalationItem {
  interactionId: string;
  nextLevel: number;
}

function extractRecipient(row: {
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
  addresseeQueue: string | null;
}): Record<string, unknown> {
  if (row.addresseeAgentId) return { agentId: row.addresseeAgentId };
  if (row.addresseeUserId) return { userId: row.addresseeUserId };
  if (row.addresseeQueue) return { serviceQueue: row.addresseeQueue };
  return {};
}

function extractNextRecipient(
  escalationChain: unknown,
  nextLevel: number,
): Record<string, unknown> {
  if (Array.isArray(escalationChain) && escalationChain.length >= nextLevel && nextLevel >= 1) {
    const step = escalationChain[nextLevel - 1];
    if (step && typeof step === "object") {
      if ("recipient" in step && step.recipient && typeof step.recipient === "object") {
        return step.recipient as Record<string, unknown>;
      }
      return step as Record<string, unknown>;
    }
  }
  return {};
}

export async function selectDueEscalations(
  db: Db,
  now: Date = new Date(),
  limit: number = 50,
): Promise<DueEscalationItem[]> {
  if (limit <= 0) {
    return [];
  }

  const candidates = await db
    .select({
      id: issueThreadInteractions.id,
      companyId: issueThreadInteractions.companyId,
      escalationLevel: issueThreadInteractions.escalationLevel,
      escalationChain: issueThreadInteractions.escalationChain,
      addresseeAgentId: issueThreadInteractions.addresseeAgentId,
      addresseeUserId: issueThreadInteractions.addresseeUserId,
      addresseeQueue: issueThreadInteractions.addresseeQueue,
    })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.status, "pending"),
        isNotNull(issueThreadInteractions.timeoutAt),
        lte(issueThreadInteractions.timeoutAt, now),
        notExists(
          db
            .select({ one: sql`1` })
            .from(interactionEscalations)
            .where(
              and(
                eq(interactionEscalations.interactionId, issueThreadInteractions.id),
                eq(
                  interactionEscalations.level,
                  sql`${issueThreadInteractions.escalationLevel} + 1`,
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(issueThreadInteractions.timeoutAt), asc(issueThreadInteractions.id))
    .limit(limit);

  if (candidates.length === 0) {
    return [];
  }

  const rowsToInsert = candidates.map((candidate) => {
    const nextLevel = (candidate.escalationLevel ?? 0) + 1;
    return {
      companyId: candidate.companyId,
      interactionId: candidate.id,
      level: nextLevel,
      fromRecipient: extractRecipient(candidate),
      toRecipient: extractNextRecipient(candidate.escalationChain, nextLevel),
      reason: "timeout",
      createdAt: now,
    };
  });

  const inserted = await db
    .insert(interactionEscalations)
    .values(rowsToInsert)
    .onConflictDoNothing()
    .returning({
      interactionId: interactionEscalations.interactionId,
      nextLevel: interactionEscalations.level,
    });

  return inserted;
}
