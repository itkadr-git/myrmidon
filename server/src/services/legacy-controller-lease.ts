import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@myrmidon/db";
import { backgroundInterval } from "../myrmidon/monitoring/board-load/lanes.js"; // myrmidon(1.6.6 OPE-9058)

// A boot UUID has meaning across containers; a numeric PID does not.
export const legacyControllerBootId = randomUUID();
export const LEGACY_CONTROLLER_LEASE_MS = 60_000;
export const LEGACY_CONTROLLER_RENEW_MS = 10_000;
// myrmidon(OPE-12578): how long a lease deadline waits for a renewal to confirm
// that this process still owns the run before it aborts the adapter.
export const LEGACY_CONTROLLER_DEADLINE_CONFIRM_MS = 5_000;

type Run = typeof heartbeatRuns.$inferSelect;

/** Commit these fields in the same UPDATE that claims a queued run. */
export function legacyControllerClaim(runtimeMode: string) {
  if (runtimeMode === "native") return {};
  return {
    controllerBootId: legacyControllerBootId,
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    executionStage: "preparing",
  };
}

// myrmidon(OPE-12578): ownership is the boot id. Revocation always replaces it
// (revokeExpiredLegacyController), so a run that still carries this process's
// boot id was not taken over and renews even after its expiry passed. Before,
// an expired lease could not renew: when this process's own event loop stalled
// past the lease (78 s on 10.11), every run it controlled was cancelled on
// resume although nobody had claimed them.
export async function renewLegacyControllerLease(
  db: Db,
  run: Pick<Run, "id" | "companyId" | "controllerBootId">,
  stage?: "dispatching",
): Promise<boolean> {
  const [renewed] = await db.update(heartbeatRuns).set({
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    ...(stage ? { executionStage: stage } : {}),
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(renewed);
}

export async function hasLiveLegacyController(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return false;
  const [owner] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  ));
  return Boolean(owner);
}

/** Read the committed row without waiting on a renewal's row lock. */
async function readLegacyControllerLeaseState(db: Db, run: Pick<Run, "id" | "companyId">) {
  const [row] = await db.select({
    runtimeMode: heartbeatRuns.runtimeMode,
    status: heartbeatRuns.status,
    controllerBootId: heartbeatRuns.controllerBootId,
    controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
  ));
  if (row?.runtimeMode !== "legacy" || row.status !== "running" || row.controllerBootId !== legacyControllerBootId) {
    return null;
  }
  return row.controllerLeaseExpiresAt;
}

/** Atomically revoke an expired controller. Renewal and revocation serialize on
 * the run row. Expiry permits cleanup, never dispatch of a replacement agent. */
export async function revokeExpiredLegacyController(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return true;
  const [revoked] = await db.update(heartbeatRuns).set({
    controllerBootId: randomUUID(),
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, run.controllerBootId),
    lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(revoked);
}

/** After the local deadline, try to renew. If its reply times out, allow one
 * more confirm window to check the committed lease before aborting. */
export function watchLegacyControllerLease(db: Db, run: Run, controller: AbortController) {
  if (run.runtimeMode === "native" || !run.controllerBootId) {
    return { stop() {}, async assertOwned(_stage?: "dispatching") {} };
  }
  let stopped = false;
  let pending = false;
  const lost = () => {
    if (stopped) return;
    const error = new Error("Legacy controller lease lost");
    error.name = "ControllerLeaseLost";
    controller.abort(error);
  };
  let confirm: ReturnType<typeof setTimeout> | null = null;
  let verify: ReturnType<typeof setTimeout> | null = null;
  const confirmLease = () => {
    if (stopped || controller.signal.aborted) return;
    // The UPDATE can already be committed even though its response is late.
    const timeout = setTimeout(() => {
      verify = null;
      lost();
    }, LEGACY_CONTROLLER_DEADLINE_CONFIRM_MS);
    timeout.unref();
    verify = timeout;
    const finish = (expiresAt: Date | null) => {
      if (verify !== timeout) return;
      clearTimeout(timeout);
      verify = null;
      if (stopped || controller.signal.aborted) return;
      const remaining = (expiresAt?.getTime() ?? 0) - Date.now();
      if (remaining > 0) armDeadline(remaining);
      else lost();
    };
    void readLegacyControllerLeaseState(db, run).then(finish, () => finish(null));
  };
  const onDeadline = () => {
    if (stopped || controller.signal.aborted || confirm || verify) return;
    const timeout = setTimeout(() => {
      confirm = null;
      confirmLease();
    }, LEGACY_CONTROLLER_DEADLINE_CONFIRM_MS);
    confirm = timeout;
    timeout.unref();
    void assertOwned().then(() => {
      if (confirm !== timeout) return;
      clearTimeout(timeout);
      confirm = null;
    }, () => {
      if (confirm !== timeout) return;
      clearTimeout(timeout);
      confirm = null;
      lost();
    });
  };
  let deadline = setTimeout(onDeadline, Math.max(0,
    (run.controllerLeaseExpiresAt?.getTime() ?? 0) - Date.now()));
  deadline.unref();
  const armDeadline = (remaining: number) => {
    clearTimeout(deadline);
    deadline = setTimeout(onDeadline, Math.max(0, remaining));
    deadline.unref();
  };
  const assertOwned = async (stage?: "dispatching") => {
    if (stopped) return;
    controller.signal.throwIfAborted();
    const startedAt = Date.now();
    const observedDeadline = deadline;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    let renewed: boolean;
    try {
      renewed = await Promise.race([renewLegacyControllerLease(db, run, stage), aborted]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
    if (stopped) return;
    if (!renewed) {
      lost();
      controller.signal.throwIfAborted();
    }
    controller.signal.throwIfAborted();
    // A late response must not replace a deadline already set by the DB read.
    if (!verify && deadline === observedDeadline) {
      armDeadline(LEGACY_CONTROLLER_LEASE_MS - (Date.now() - startedAt));
    }
  };
  const timer = backgroundInterval(() => {
    if (pending || stopped) return;
    pending = true;
    void assertOwned().catch(() => {
      // A refused renewal already aborted inside assertOwned; anything else is
      // retried on the next tick and bounded by the deadline.
    }).finally(() => { pending = false; });
  }, LEGACY_CONTROLLER_RENEW_MS);
  timer.unref();
  return { assertOwned, stop() {
    stopped = true; clearInterval(timer); clearTimeout(deadline);
    if (confirm) clearTimeout(confirm);
    if (verify) clearTimeout(verify);
    confirm = verify = null;
  } };
}
