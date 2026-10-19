// myrmidon(1.6.5-F21-B): the attention-feed card for owner decision cards
// that are still waiting on the owner.
//
// The feed item is computed on the fly from `issue_thread_interactions` (the
// same population the TTL sweep reads), so it exists exactly while at least
// one owner card is pending, and disappears when the last one is answered,
// resolved by silence-means-recommended, or expired. Nothing is persisted —
// the same "computed on the fly" shape as the execution-hold cards.

import { and, eq, isNull, sql } from "drizzle-orm";
import { issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { isOwnerDecisionAudience } from "@paperclipai/shared";
import { OWNER_CARD_STALE_AGE_MS } from "./settings.js";

export interface OwnerPendingCardsSummary {
  companyId: string;
  /** Pending owner request_confirmation cards in the company. */
  pending: number;
  /** Of those, older than OWNER_CARD_STALE_AGE_MS (3 days). */
  stale: number;
  /** ISO time of the oldest pending owner card. */
  oldestCreatedAt: string;
}

/**
 * Counts the pending owner cards of one company. A card is an owner card when
 * the same audience rule as the owner delivery applies
 * (`isOwnerDecisionAudience` from shared): the effective resolver policy is
 * `human_only`, or the addressee user is the task owner
 * (responsibleUserId ?? createdByUserId); agent-addressed cards never count.
 */
export async function summarizeOwnerPendingCards(
  db: Db,
  companyId: string,
  staleAgeMs: number = OWNER_CARD_STALE_AGE_MS,
): Promise<OwnerPendingCardsSummary | null> {
  const rows = await db
    .select({
      id: issueThreadInteractions.id,
      createdAt: issueThreadInteractions.createdAt,
      effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
      addresseeAgentId: issueThreadInteractions.addresseeAgentId,
      addresseeUserId: issueThreadInteractions.addresseeUserId,
      ownerUserId: sql<string | null>`coalesce(${issues.responsibleUserId}, ${issues.createdByUserId})`,
    })
    .from(issueThreadInteractions)
    .innerJoin(
      issues,
      and(
        eq(issues.id, issueThreadInteractions.issueId),
        isNull(issues.hiddenAt),
      ),
    )
    .where(
      and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        eq(issueThreadInteractions.status, "pending"),
      ),
    )
    .orderBy(issueThreadInteractions.createdAt);

  const ownerCards = rows.filter((row) =>
    isOwnerDecisionAudience({
      effectiveResolverPolicy: row.effectiveResolverPolicy,
      addresseeAgentId: row.addresseeAgentId,
      addresseeUserId: row.addresseeUserId,
      ownerUserId: row.ownerUserId,
    }),
  );
  if (ownerCards.length === 0) return null;

  const staleCutoff = Date.now() - staleAgeMs;
  const stale = ownerCards.filter((row) => row.createdAt.getTime() < staleCutoff).length;
  return {
    companyId,
    pending: ownerCards.length,
    stale,
    oldestCreatedAt: ownerCards[0]!.createdAt.toISOString(),
  };
}

export function ownerCardsAttentionDedupKey(companyId: string): string {
  return `owner_pending_cards:${companyId}`;
}

/** «карточек владельца pending: N (старше 3 дней: M)» — the wording the ticket fixes. */
export function ownerCardsAttentionTitle(summary: OwnerPendingCardsSummary): string {
  return `карточек владельца pending: ${summary.pending} (старше 3 дней: ${summary.stale})`;
}

export function ownerCardsAttentionWhyNow(summary: OwnerPendingCardsSummary): string {
  const stalePart =
    summary.stale > 0
      ? ` ${summary.stale} of them have been waiting for more than 3 days and are at or past the TTL, so the TTL sweep is about to close them (silence-means-recommended cards resolve by the recommended option, the rest expire).`
      : "";
  return `${summary.pending} owner decision card${summary.pending === 1 ? " is" : "s are"} waiting for the owner's answer.${stalePart} Answer the cards on the tasks or let the TTL sweep close them.`;
}
