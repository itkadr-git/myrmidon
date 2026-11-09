import { and, eq, lt } from "drizzle-orm";
import { issueContinuationKeys, type Db } from "@myrmidon/db";
import { isUniqueViolation } from "../db-errors.js";
import { continuationDedupeMetrics } from "./continuation-dedupe-metrics.js";

export type ContinuationDedupeOutcome = "created" | "deduped";

export async function tryClaimContinuationKey(
  db: Db,
  input: { companyId: string; key: string; issueId: string; ttl: number },
): Promise<ContinuationDedupeOutcome> {
  return tryClaimContinuationKeyInTransaction(db, input);
}

/** Claim on a caller-owned transaction so dedupe and admission commit together. */
export async function tryClaimContinuationKeyInTransaction(
  tx: Db,
  input: { companyId: string; key: string; issueId: string; ttl: number },
): Promise<ContinuationDedupeOutcome> {
  const now = new Date();
  // Reclaim this exact key only when its lease has expired. This keeps the
  // public claim contract (expired keys can be retried directly) without
  // turning an active concurrent claim into an upsert/refresh race.
  await tx
    .delete(issueContinuationKeys)
    .where(
      and(
        eq(issueContinuationKeys.companyId, input.companyId),
        eq(issueContinuationKeys.key, input.key),
        lt(issueContinuationKeys.expiresAt, now),
      ),
    );

  let inserted: { key: string }[];
  try {
    inserted = await tx
      .insert(issueContinuationKeys)
      .values({
        companyId: input.companyId,
        key: input.key,
        issueId: input.issueId,
        expiresAt: new Date(now.getTime() + input.ttl),
      })
      // A continuation claim is a one-shot admission token.  Do not refresh
      // an existing row on conflict: concurrent callers must observe one
      // creator and all other deliveries must be deduped. Expired rows are
      // removed by clearExpiredContinuationKeys before a new admission.
      .onConflictDoNothing({
        target: [issueContinuationKeys.companyId, issueContinuationKeys.key],
      })
      .returning({ key: issueContinuationKeys.key });
  } catch (err) {
    if (
      isUniqueViolation(err, "issue_continuation_keys_company_key_uq") ||
      isUniqueViolation(err)
    ) {
      inserted = [];
    } else {
      throw err;
    }
  }

  const outcome: ContinuationDedupeOutcome = inserted.length
    ? "created"
    : "deduped";
  if (outcome === "created")
    continuationDedupeMetrics.metrics.onContinuationCreated(input.key);
  else continuationDedupeMetrics.metrics.onContinuationDeduped(input.key);
  return outcome;
}

export async function clearExpiredContinuationKeys(
  db: Db,
  companyId?: string,
  now = new Date(),
): Promise<number> {
  const conditions = [lt(issueContinuationKeys.expiresAt, now)];
  if (companyId) {
    conditions.push(eq(issueContinuationKeys.companyId, companyId));
  }
  const deleted = await db
    .delete(issueContinuationKeys)
    .where(and(...conditions))
    .returning({ key: issueContinuationKeys.key });
  return deleted.length;
}

export async function releaseContinuationKey(
  db: Db,
  input: { companyId: string; key: string },
): Promise<number> {
  const deleted = await db
    .delete(issueContinuationKeys)
    .where(
      and(
        eq(issueContinuationKeys.companyId, input.companyId),
        eq(issueContinuationKeys.key, input.key),
      ),
    )
    .returning({ key: issueContinuationKeys.key });
  return deleted.length;
}
