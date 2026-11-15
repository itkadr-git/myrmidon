// myrmidon(1.8 ACP / OPE-12942): the one bounded mapping from an external
// agent job's terminal callback to board execution state. The external agent
// (ACP provider — hermes_gateway, codex-local, ...) reports completion,
// failure, or cancellation for a job it runs on the board's behalf. This
// module is the single place where such a callback is translated into a
// board state, so every provider goes through the same rules:
//
//  - a terminal callback maps exactly once per provider job id (a duplicate
//    callback is an idempotent no-op that replays the recorded mapping);
//  - "completed" maps to done ONLY with completion evidence (non-empty
//    output or result) — a bare "completed" never closes the issue;
//  - malformed or unknown provider states are non-terminal holds — they
//    never close the issue and never invent a verdict;
//  - the provider job id is retained on every mapping for reconciliation
//    (the board persists it into heartbeat_runs.external_run_id).
//
// Pure data module: no I/O, no clocks, no DB. The caller owns persistence.

/** Board states a terminal callback may legally produce. */
export type BoardTerminalState = "done" | "failed" | "cancelled";

/**
 * The outcome of one external-job terminal callback.
 *
 * `terminal` — the callback mapped to a board terminal state; the board may
 * close/fail/cancel the run. `non_terminal` — the callback must NOT change
 * the run's terminal state: unknown or malformed provider status, or a
 * "completed" without the required completion evidence. The board keeps the
 * run on its existing hold/reconciliation path instead.
 */
export type MappedTerminalCallback =
  | { kind: "terminal"; boardState: BoardTerminalState; providerJobId: string | null }
  | { kind: "non_terminal"; holdReason: string };

export interface TerminalCallbackInput {
  /** Provider identity (e.g. "hermes_gateway") — carried for audit only. */
  provider: string;
  /** Provider job id, retained for reconciliation. */
  providerJobId: string | null | undefined;
  /** Raw provider status string, as received — may be anything. */
  status: string | null | undefined;
  /** Completion evidence: non-empty output or result proves real work. */
  completionEvidence?: { output?: string | null; result?: string | null } | null;
}

// Closed map of known provider terminal statuses → board states. Anything
// outside this map is a hold. Synonyms of the same verdict are listed once
// here so providers need no per-provider adapters.
const KNOWN_TERMINAL: Readonly<Record<string, BoardTerminalState>> = {
  completed: "done",
  succeeded: "done",
  success: "done",
  failed: "failed",
  error: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
};

// Known in-flight statuses: explicitly non-terminal, a callback carrying one
// is a progress report, not a verdict.
const KNOWN_IN_FLIGHT: ReadonlySet<string> = new Set([
  "queued",
  "pending",
  "starting",
  "running",
  "in_progress",
]);

/** Non-empty string that is not pure whitespace. */
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Map ONE terminal callback to a board state. Stateless and total: it never
 * throws on malformed input and never returns a terminal verdict for
 * malformed, unknown, or unevidenced callbacks.
 */
export function mapTerminalCallback(input: TerminalCallbackInput): MappedTerminalCallback {
  const status = typeof input.status === "string" ? input.status.trim().toLowerCase() : null;
  if (!status) {
    return { kind: "non_terminal", holdReason: "malformed_provider_status" };
  }
  const known = KNOWN_TERMINAL[status];
  if (!known) {
    // Unknown status: never guess. In-flight statuses hold as progress;
    // anything else holds as unrecognizable.
    return {
      kind: "non_terminal",
      holdReason: KNOWN_IN_FLIGHT.has(status) ? "provider_status_in_flight" : "unknown_provider_status",
    };
  }
  if (known === "done" && !nonEmpty(input.completionEvidence?.output) && !nonEmpty(input.completionEvidence?.result)) {
    // External callback cannot mark done without completion evidence.
    return { kind: "non_terminal", holdReason: "completion_evidence_missing" };
  }
  const normalizedJobId = nonEmpty(input.providerJobId) ? input.providerJobId.trim() : null;
  return { kind: "terminal", boardState: known, providerJobId: normalizedJobId };
}

export interface RecordedTerminalCallback {
  /** True only for the FIRST terminal callback of the job. */
  applied: boolean;
  providerJobId: string;
  /** The mapping recorded for the job (replayed unchanged on duplicates). */
  mapping: MappedTerminalCallback;
}

/**
 * Idempotent registry of terminal callbacks keyed by provider job id.
 * The first terminal callback per job applies and is recorded; every
 * duplicate (same or different status, malformed or not) is an idempotent
 * no-op that replays the recorded mapping. Non-terminal mappings are never
 * recorded — a later, well-formed terminal callback must still be able to
 * settle the job.
 */
export class TerminalCallbackRegistry {
  private readonly recorded = new Map<string, MappedTerminalCallback>();

  apply(input: TerminalCallbackInput): RecordedTerminalCallback {
    const rawJobId = nonEmpty(input.providerJobId);
    if (!rawJobId) {
      // Missing or empty providerJobId cannot safely reconcile with any other job;
      // evaluate mapping without latching a shared singleton key.
      const mapping = mapTerminalCallback(input);
      return { applied: mapping.kind === "terminal", providerJobId: "", mapping };
    }
    const providerJobId = String(input.providerJobId).trim();
    const recorded = this.recorded.get(providerJobId);
    if (recorded) {
      return { applied: false, providerJobId, mapping: recorded };
    }
    const mapping = mapTerminalCallback(input);
    if (mapping.kind === "terminal") {
      this.recorded.set(providerJobId, mapping);
    }
    return { applied: true, providerJobId, mapping };
  }

  /** Reconciliation read: the verdict recorded for a job, if any. */
  recordedMapping(providerJobId: string): MappedTerminalCallback | null {
    return this.recorded.get(providerJobId) ?? null;
  }
}
