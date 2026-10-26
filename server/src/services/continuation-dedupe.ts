import { and, eq, lt } from "drizzle-orm";
import { issueContinuationKeys } from "@paperclipai/db";
import type { createDb } from "@paperclipai/db";
import { isUniqueViolation } from "../db-errors.js";

export type ContinuationDedupeOutcome = "created" | "deduped";
type Db = ReturnType<typeof createDb>;

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
      if (isUniqueViolation(err, "issue_continuation_keys_company_key_uq")) return [];
      throw err;
    });
  return inserted.length ? "created" : "deduped";
}

export async function clearExpiredContinuationKeys(
  db: Db,
  companyId: string,
  now = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(issueContinuationKeys)
    .where(and(eq(issueContinuationKeys.companyId, companyId), lt(issueContinuationKeys.expiresAt, now)))
    .returning({ key: issueContinuationKeys.key });
  return deleted.length;
}
