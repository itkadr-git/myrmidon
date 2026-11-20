import type { Db } from "@myrmidon/db";
import { processNativeFinalizationRequest as processRequest } from "./native-finalization-request-recovery.js";

/** Compatibility wrapper for callers using the original worker interface. */
export async function processNativeFinalizationRequest(db: Db, worker: string, now: Date, leaseMs: number) {
  let decision: Awaited<ReturnType<typeof import("./native-run-finalizer.js").finalizeNativeRun>> | null = null;
  const { finalizeNativeRun } = await import("./native-run-finalizer.js");
  const outcome = await processRequest({ db, worker, now, leaseMs, execute: async (request) => {
    decision = await finalizeNativeRun({ db, ...request, projectRunStatus: true });
  } });
  if (outcome === "waiting_workspace") throw new Error("native_finalization_workspace_not_ready");
  return decision;
}
