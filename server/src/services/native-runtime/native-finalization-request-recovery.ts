import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
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
