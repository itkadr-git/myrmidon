// myrmidon(OPE-12808): what the board does with a run it has already marked
// stalled while the agent process behind it is still alive.
//
// The sweep cancels the run row (error code `run_stalled`), but an agent whose
// workspace sync or build was only quiet — not dead — keeps going and, when it
// finishes, asks the board for credentials or hands its result in. Before this
// module that request met a bare 403 ("requires this agent's active run").
// The chosen behaviour: a run cancelled by the stall sweep may still obtain
// its credentials for a bounded grace window after the cancellation (long
// enough to push and report, short enough that a truly dead run's token goes
// cold), and after the window — or for any other terminal run — the refusal
// names its reason. No process is killed here; stopping a run for real is the
// separate cancel-path task.

import { RUN_STALL_ERROR_CODE } from "./constants.js";

/** Default grace after a stall interrupt, seconds. */
export const RUN_STALL_GRACE_DEFAULT_SEC = 600;
/** Environment override of the grace, seconds; 0 turns the grace off. */
export const RUN_STALL_GRACE_ENV = "MYRMIDON_RUN_STALL_GRACE_SEC";
/** Machine-readable code of the refusal for a run the stall sweep interrupted. */
export const RUN_STALL_REFUSAL_CODE = "run_stalled";
export const RUN_STALL_REFUSAL_MESSAGE =
  "Run was interrupted as stalled (no recorded progress within the stall threshold); it can no longer act on the board";

export function readRunStallGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RUN_STALL_GRACE_ENV];
  if (raw === undefined || raw.trim() === "") return RUN_STALL_GRACE_DEFAULT_SEC * 1000;
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec < 0) return RUN_STALL_GRACE_DEFAULT_SEC * 1000;
  return Math.floor(sec) * 1000;
}

export interface RunLifecycleView {
  status: string;
  errorCode: string | null;
  finishedAt: Date | null;
  updatedAt: Date | null;
}

export type RunActingDecision =
  /** The run is live: act as before. */
  | { kind: "active" }
  /** Interrupted as stalled, still inside the grace window. */
  | { kind: "stall_grace"; graceLeftMs: number }
  /** Interrupted as stalled, grace spent: refuse with the stall reason. */
  | { kind: "stall_expired"; interruptedAt: Date | null }
  /** Any other non-running state: the generic refusal stays. */
  | { kind: "inactive" };

export function decideRunActing(run: RunLifecycleView, now: Date, graceMs: number): RunActingDecision {
  if (run.status === "running") return { kind: "active" };
  if (run.status !== "cancelled" || run.errorCode !== RUN_STALL_ERROR_CODE) return { kind: "inactive" };
  const interruptedAt = run.finishedAt ?? run.updatedAt;
  if (!interruptedAt) return { kind: "stall_expired", interruptedAt: null };
  const left = graceMs - (now.getTime() - interruptedAt.getTime());
  return left > 0 ? { kind: "stall_grace", graceLeftMs: left } : { kind: "stall_expired", interruptedAt };
}

/** Details attached to the named refusal. */
export function runStallRefusalDetails(runId: string, interruptedAt: Date | null, graceMs: number) {
  return {
    code: RUN_STALL_REFUSAL_CODE,
    runId,
    interruptedAt: interruptedAt ? interruptedAt.toISOString() : null,
    graceSec: Math.floor(graceMs / 1000),
    remediation: "The task was returned to the queue and the assignee is woken with a new run; continue there.",
  };
}
