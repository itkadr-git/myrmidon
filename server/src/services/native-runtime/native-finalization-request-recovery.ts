import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { nativeFinalizationOutbox, nativeFinalizationRequests, type Db } from "@myrmidon/db";

/** Claim pending work or reclaim a lease abandoned by a crashed worker. */
export async function claimNativeFinalizationRequest(db: Db, worker: string, now: Date, leaseMs: number) {
  if (!worker || !Number.isFinite(now.getTime()) || !Number.isFinite(leaseMs) || leaseMs <= 0) {
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
      state: "processing", leaseOwner: worker, leaseUntil: new Date(now.getTime() + leaseMs),
    }).where(eq(nativeFinalizationRequests.id, candidate.id)).returning();
    return request ?? null;
  });
}

/** Settle only the current lease, atomically with consuming the outbox entry. */
export async function settleNativeFinalizationRequest(
  db: Db, requestId: string, worker: string, now: Date,
  result: { decisionId: string } | { errorCode: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [settled] = await tx.update(nativeFinalizationRequests).set({
      state: "decisionId" in result ? "committed" : "rejected",
      resultDecisionId: "decisionId" in result ? result.decisionId : null,
      errorCode: "errorCode" in result ? result.errorCode : null,
      completedAt: now, leaseOwner: null, leaseUntil: null,
    }).where(and(
      eq(nativeFinalizationRequests.id, requestId),
      eq(nativeFinalizationRequests.state, "processing"),
      eq(nativeFinalizationRequests.leaseOwner, worker),
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
