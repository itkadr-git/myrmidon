import { and, desc, eq } from "drizzle-orm";
import { workspaceOperations, type Db } from "@myrmidon/db";
import { claimNativeFinalizationRequest } from "./native-finalization-request-recovery.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";

/** Process one durable request; failures leave its lease available for recovery. */
export async function processNativeFinalizationRequest(db: Db, worker: string, now: Date, leaseMs: number) {
  const request = await claimNativeFinalizationRequest(db, worker, now, leaseMs);
  if (!request) return null;
  if (!request.leaseOwner || !request.leaseUntil) throw new Error("native_finalization_invalid_lease");
  const [barrier] = await db.select({ status: workspaceOperations.status })
    .from(workspaceOperations)
    .where(and(
      eq(workspaceOperations.companyId, request.companyId),
      eq(workspaceOperations.heartbeatRunId, request.runId),
      eq(workspaceOperations.phase, "workspace_finalize"),
    ))
    .orderBy(desc(workspaceOperations.createdAt))
    .limit(1);
  if (barrier?.status !== "succeeded") throw new Error("native_finalization_workspace_not_ready");
  return finalizeNativeRun({
    db, runId: request.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true,
    serviceRequest: { requestId: request.id, leaseOwner: request.leaseOwner, leaseUntil: request.leaseUntil },
  });
}
