// myrmidon(OPE-12929): optional not-before boundary for deferred agent runs.
//
// A wake can carry an optional `notBefore` instant in its run context. The
// queued-run dispatcher must not claim (start) that run before the instant is
// reached: the run stays an ordinary queued run and the ordinary retries —
// the periodic sweep, the admission resweep, any later wake of the same
// agent — pick it up once the time arrives. This mirrors the wake-batch
// debounce window (1.6.6 INBOX-BATCH): the hold writes nothing of its own and
// is retried by the same one-per-process resweep machinery.
//
// Contract (acceptance criteria of OPE-12929):
//   - time is compared as a UTC instant (epoch milliseconds);
//   - a run whose notBefore lies in the future is held (stays pending);
//   - a run whose notBefore is reached (equal or past) starts as before;
//   - a missing, empty or unparsable value changes nothing — the run keeps
//     the pre-feature behavior and is never held by this gate.
//
// Pure module: the caller reads the database and the clock and hands in the
// run's context snapshot; this file only branches on that input.

/** The context key a wake sets to request the not-before hold. ISO-8601 UTC string. */
export const RUN_NOT_BEFORE_CONTEXT_KEY = "notBefore";

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export type RunNotBeforeDecision =
  | { hold: false; reason: "missing" | "invalid" | "reached" }
  | { hold: true; notBefore: Date };

/**
 * Decides for one run whether its not-before instant still holds it.
 *
 * The value is read as a string and parsed with `Date.parse`, so an
 * ISO-8601 string with a `Z`/offset is compared as a UTC instant. A
 * non-string, an empty string or an unparsable string returns a non-hold
 * decision with reason `"missing"`/`"invalid"` — a broken value must never
 * park a run (acceptance: a missing or incorrect value preserves the old
 * behavior). The boundary instant itself counts as reached.
 */
export function decideRunNotBefore(input: {
  contextSnapshot: unknown;
  now: Date;
}): RunNotBeforeDecision {
  const context = parseObject(input.contextSnapshot);
  const raw = readNonEmptyString(context[RUN_NOT_BEFORE_CONTEXT_KEY]);
  if (raw === null) return { hold: false, reason: "missing" };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { hold: false, reason: "invalid" };
  if (ms <= input.now.getTime()) return { hold: false, reason: "reached" };
  return { hold: true, notBefore: new Date(ms) };
}

/** One run the not-before instant holds back. */
export type RunNotBeforeHold = {
  runId: string;
  /** The task the run stands on, for the log line. */
  issueId: string | null;
  /** The moment the hold lifts. */
  notBefore: Date;
  remainingMs: number;
};

export type RunNotBeforeSplit<T> = {
  /** The runs this pass may claim, in the order it received them. */
  runnable: T[];
  /** The runs the instant holds back, in the order it received them. */
  held: RunNotBeforeHold[];
};

/**
 * Splits this agent's queued runs into the ones a pass may claim and the
 * ones whose not-before instant has not arrived yet. Held runs are left out
 * of the claim pass entirely rather than skipped inside it, the same way the
 * wake-batch window holds runs: the admission counts slots for the runs it
 * is offered, so a held run must not take one.
 */
export function splitRunsHeldByNotBefore<
  T extends { id: string; contextSnapshot: unknown },
>(runs: readonly T[], options: { now: Date }): RunNotBeforeSplit<T> {
  const runnable: T[] = [];
  const held: RunNotBeforeHold[] = [];
  for (const run of runs) {
    const decision = decideRunNotBefore({
      contextSnapshot: run.contextSnapshot,
      now: options.now,
    });
    if (!decision.hold) {
      runnable.push(run);
      continue;
    }
    held.push({
      runId: run.id,
      issueId: readNonEmptyString(parseObject(run.contextSnapshot).issueId),
      notBefore: decision.notBefore,
      remainingMs: decision.notBefore.getTime() - options.now.getTime(),
    });
  }
  return { runnable, held };
}
