/**
 * Test helpers for the effect-worker layer (OPE-12798).
 *
 * Test discipline (t3code AGENTS.md G, INV-15): tests drain the worker and
 * wait for concrete persisted milestones — never `sleep`. All helpers here
 * are deterministic: they operate on the embedded Postgres in the same
 * process, so a drain is synchronous with respect to the test, and milestone
 * waits are bounded loops over the database, not timers.
 */
import { eq } from "drizzle-orm";
import { agentWakeupRequests } from "@myrmidon/db";
import type { Db } from "@myrmidon/db";
import type { EffectWorker } from "./effect-worker.js";

/**
 * Drain the effect worker once. In tests the worker runs in-process against
 * the same embedded database, so after `await drainEffects(...)` every effect
 * the handler could process has been processed — no waiting is needed.
 */
export async function drainEffects(
  worker: EffectWorker,
  input?: { kinds?: string[]; limit?: number; staleClaimMs?: number },
) {
  return worker.drain(input);
}

/**
 * Drain repeatedly until the worker reports no more work (or the iteration
 * budget is exhausted). Still sleep-free: each iteration is a real drain of
 * real queued rows.
 */
export async function drainEffectsUntilIdle(
  worker: EffectWorker,
  input?: { kinds?: string[]; limit?: number; staleClaimMs?: number },
  maxIterations = 20,
) {
  let last;
  for (let i = 0; i < maxIterations; i += 1) {
    last = await worker.drain(input);
    const total = last.settled + last.released + last.skipped + last.failed;
    if (total === 0) break;
  }
  return last ?? { scanned: 0, settled: 0, released: 0, skipped: 0, failed: 0 };
}

/**
 * Wait for a concrete persisted milestone on an intent row. The milestone is
 * matched by `matcher` against the row's `payload.effect` object.
 *
 * This is a bounded loop over database state, not a timer: in embedded-Postgres
 * tests the row is updated by the in-process worker before `drainEffects`
 * resolves, so the first read already observes the milestone. The loop exists
 * only to absorb interleaved async writes from fire-and-forget post-commit
 * paths; each iteration re-reads the row directly.
 */
export async function waitForEffectMilestone(
  db: Db,
  idempotencyKey: string,
  matcher: (effect: Record<string, unknown>) => boolean,
  maxIterations = 200,
): Promise<Record<string, unknown>> {
  let lastEffect: Record<string, unknown> | null = null;
  for (let i = 0; i < maxIterations; i += 1) {
    const rows = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey))
      .limit(1);
    const payload = (rows[0]?.payload ?? null) as Record<string, unknown> | null;
    const effect = (payload?.effect ?? null) as Record<string, unknown> | null;
    if (effect && matcher(effect)) {
      return effect;
    }
    lastEffect = effect;
    // Yield to the event loop so any in-flight async writer can land; this is
    // a scheduler yield, not a sleeping wait.
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `waitForEffectMilestone: milestone not reached for ${idempotencyKey}; last effect=${JSON.stringify(lastEffect)}`,
  );
}
