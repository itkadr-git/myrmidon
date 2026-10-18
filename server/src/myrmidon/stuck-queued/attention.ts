// myrmidon(1.6.5 F-09): the attention signal of a queued run that has been
// waiting longer than the instance's stall threshold without a waitReason.
//
// The signal is computed on the fly by the attention feed (no sweep): the
// heartbeat sweep already writes `waitReason` onto every queued run older
// than the explain threshold, so a run that still has no reason after the
// stall threshold is a bug worth a person's attention. The card disappears
// as soon as the run is claimed or gets a reason.

import type { AttentionSeverity } from "@paperclipai/shared";

export interface QueueStallSignal {
  runId: string;
  companyId: string;
  agentId: string;
  agentName: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  /** ISO time the run was created (the wait started). */
  since: string;
  /** Seconds the run has been queued. */
  queuedSec: number;
}

export function queueStallSignalDedupKey(signal: QueueStallSignal): string {
  return `queue_stall:${signal.runId}`;
}

export function queueStallSignalTitle(): string {
  return "A queued run waits without a reason";
}

export function queueStallSignalWhyNow(signal: QueueStallSignal): string {
  const name = signal.agentName ? ` (${signal.agentName})` : "";
  return `A queued run of agent${name} has been waiting ${signal.queuedSec} s without a recorded reason. The sweep should have written a waitReason; investigate why it did not.`;
}

export function queueStallSignalSeverity(): AttentionSeverity {
  return "high";
}

export function queueStallSignalDetail(signal: QueueStallSignal): string {
  return `runId=${signal.runId} agentId=${signal.agentId} issueId=${signal.issueId ?? "—"} queuedSec=${signal.queuedSec}`;
}
