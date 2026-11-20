import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { nativeFinalizationOutbox, nativeFinalizationRequests, type Db } from "@myrmidon/db";

/** Claim pending work or reclaim a lease abandoned by a crashed worker. */
export async function claimNativeFinalizationRequest(db: Db, worker: string, now: Date, leaseMs: number) {
  const leaseUntil = new Date(now.getTime() + leaseMs);
  if (!worker.trim() || !Number.isFinite(now.getTime()) || !Number.isFinite(leaseMs) || leaseMs <= 0 ||
      !Number.isFinite(leaseUntil.getTime()) || leaseUntil <= now) {
    throw new Error("native_finalization_invalid_lease");
  }
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select({ id: nativeFinalizationRequests.id })
      .from(nativeFinalizationRequests)
      .innerJoin(nativeFinalizationOutbox, eq(nativeFinalizationOutbox.requestId, nativeFinalizationRequests.id))
      .where(and(
        isNull(nativeFinalizationOutbox.dispatchedAt),
        or(
          eq(nativeFinalizationRequests.state, "accepted"),
          and(eq(nativeFinalizationRequests.state, "processing"), lte(nativeFinalizationRequests.leaseUntil, now)),
        ),
      ))
      .orderBy(asc(nativeFinalizationOutbox.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;
    const [request] = await tx.update(nativeFinalizationRequests).set({
      state: "processing", leaseOwner: worker, leaseUntil,
    }).where(eq(nativeFinalizationRequests.id, candidate.id)).returning();
    return request ?? null;
  });
}

/** Settle only the current lease, atomically with consuming the outbox entry. */
export async function settleNativeFinalizationRequest(
  db: Db, requestId: string, worker: string, now: Date,
  result: { decisionId: string } | { errorCode: string },
  leaseUntil: Date,
): Promise<boolean> {
  if ("decisionId" in result) {
    throw new Error("native_finalization_commit_requires_decision_transaction");
  }
  if (!worker.trim() || !Number.isFinite(now.getTime()) || !Number.isFinite(leaseUntil.getTime()) || !result.errorCode.trim()) {
    throw new Error("native_finalization_invalid_settlement");
  }
  return db.transaction(async (tx) => {
    const [settled] = await tx.update(nativeFinalizationRequests).set({
      state: "rejected",
      resultDecisionId: null,
      errorCode: result.errorCode,
      completedAt: now, leaseOwner: null, leaseUntil: null,
    }).where(and(
      eq(nativeFinalizationRequests.id, requestId),
      eq(nativeFinalizationRequests.state, "processing"),
      eq(nativeFinalizationRequests.leaseOwner, worker),
      eq(nativeFinalizationRequests.leaseUntil, leaseUntil),
      gt(nativeFinalizationRequests.leaseUntil, now),
    )).returning({ id: nativeFinalizationRequests.id });
    if (!settled) return false;
    const [outbox] = await tx.update(nativeFinalizationOutbox).set({ dispatchedAt: now })
      .where(and(eq(nativeFinalizationOutbox.requestId, requestId), isNull(nativeFinalizationOutbox.dispatchedAt)))
      .returning({ requestId: nativeFinalizationOutbox.requestId });
    if (!outbox) throw new Error("native_finalization_outbox_missing");
    return true;
  });
}
