import { and, asc, eq, isNotNull, lte, notExists, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { interactionEscalations, issueThreadInteractions } from "@myrmidon/db";
import { interactionEscalationStepSchema } from "@myrmidon/shared/interaction-routing";

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
): Record<string, unknown> | null {
  const parsed = interactionEscalationStepSchema.array().safeParse(escalationChain);
  if (!parsed.success || nextLevel >= parsed.data.length || nextLevel < 1) return null;
  return parsed.data[nextLevel]?.recipient ?? null;
}

export async function selectDueEscalations(
  db: Db,
  now: Date = new Date(),
  limit: number = 50,
): Promise<DueEscalationItem[]> {
  if (limit <= 0) {
    return [];
  }

  // An invalid or exhausted chain must not claim the timeout in the journal.
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

  const rowsToInsert = candidates.flatMap((candidate) => {
    const nextLevel = (candidate.escalationLevel ?? 0) + 1;
    const toRecipient = extractNextRecipient(candidate.escalationChain, nextLevel);
    if (!toRecipient) return [];
    return [{
      companyId: candidate.companyId,
      interactionId: candidate.id,
      level: nextLevel,
      fromRecipient: extractRecipient(candidate),
      toRecipient,
      reason: "timeout",
      createdAt: now,
    }];
  });
  if (rowsToInsert.length === 0) return [];

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
