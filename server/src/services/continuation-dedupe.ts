import { and, eq, lt } from "drizzle-orm";
import { issueContinuationKeys, type Db } from "@myrmidon/db";
import { isUniqueViolation } from "../db-errors.js";

export type ContinuationDedupeOutcome = "created" | "deduped";

export async function tryClaimContinuationKey(
  db: Db,
  input: { companyId: string; key: string; issueId: string; ttl: number },
): Promise<ContinuationDedupeOutcome> {
  const now = new Date();
  await clearExpiredContinuationKeys(db, input.companyId, now);
  const inserted = await db
    .insert(issueContinuationKeys)
    .values({
      companyId: input.companyId,
      key: input.key,
      issueId: input.issueId,
      expiresAt: new Date(now.getTime() + input.ttl),
    })
    .returning({ key: issueContinuationKeys.key })
    .catch((err: unknown) => {
      if (isUniqueViolation(err, "issue_continuation_keys_company_key_uq") || isUniqueViolation(err)) return [];
      throw err;
    });
  return inserted.length ? "created" : "deduped";
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
