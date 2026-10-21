import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

// myrmidon(PROCS-2/T2.1): admission counters kept in Postgres. The gate runs
// inside the claim transaction under an advisory lock, so two worker processes
// cannot both observe the last free slot.

const RUN_ADMISSION_LOCK_KEY = "myrmidon:run-admission";

/** Whether the general instance settings put run admission into Postgres. */
export function usesDatabaseAdmission(general: { processes?: unknown } | null | undefined): boolean {
  const processes = general?.processes;
  if (!processes || typeof processes !== "object") return false;
  return (processes as Record<string, unknown>).admissionStore === "db";
}

type AdmissionTx = Pick<Db, "execute" | "select">;

/**
 * Takes the transaction-scoped admission lock and reports whether one more run
 * may move to `running`. The lock is released when the surrounding transaction
 * ends, so the caller must perform the queued->running update in the same one.
 */
export async function dbAdmissionAllowsClaim(
  tx: AdmissionTx,
  input: { agentId: string; agentLimit: number; globalLimit: number | null },
): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${RUN_ADMISSION_LOCK_KEY}, 0))`);
  if (input.globalLimit != null) {
    const [row] = await tx
      .select({ running: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    if (Number(row?.running ?? 0) >= input.globalLimit) return false;
  }
  const [agentRow] = await tx
    .select({ running: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "running")));
  return Number(agentRow?.running ?? 0) < input.agentLimit;
}
