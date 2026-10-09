// myrmidon(BLOCKED-LOOP): pure decision of the repeated-return limiter.
//
// An agent can bounce a task `blocked -> todo/in_progress -> blocked` on a
// condition the board does not model (each wake is legal on its own, the loop
// is the sum). The limiter looks at the task's recent status events, newest
// first, and counts the agent returns to `blocked` that carry the same
// blocker set and the same unblock descriptor as the return being attempted.

export type BlockedLoopEventKind =
  /** An entry into `blocked`. */
  | "entered_blocked"
  /** A move out of `blocked` into a working status (todo, in_progress, ...). */
  | "left_blocked"
  /** A move out of `blocked` into a settled status (done, cancelled, in_review). */
  | "settled";

export interface BlockedLoopEvent {
  createdAt: Date;
  actorType: string;
  kind: BlockedLoopEventKind;
  /** Signature of the blocker set recorded at the entry; null when unknown. */
  blockerSetKey: string | null;
  /** Canonical form of the unblock descriptor recorded at the entry; null when none. */
  descriptorKey: string | null;
}

export interface BlockedLoopAttempt {
  blockerSetKey: string;
  descriptorKey: string | null;
}

export interface BlockedLoopDecision {
  /** True when the attempted return must be rejected. */
  blockedLoop: boolean;
  /** Earlier consecutive matching agent returns found. */
  streak: number;
}

/**
 * `events` may come in any order; they are sorted newest first here.
 * The attempt is rejected when `streak >= maxReturns`, i.e. the attempt would
 * be return number `maxReturns + 1` without a change.
 *
 * The streak ends at: a human (non-agent) actor event, a settled status
 * (done/cancelled/in_review), an entry whose blocker set or descriptor differs
 * from the attempt (or is unknown).
 */
export function judgeBlockedLoop(
  events: readonly BlockedLoopEvent[],
  attempt: BlockedLoopAttempt,
  maxReturns: number,
): BlockedLoopDecision {
  const ordered = [...events].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  let streak = 0;
  for (const event of ordered) {
    if (event.actorType !== "agent") break;
    if (event.kind === "settled") break;
    if (event.kind === "left_blocked") continue;
    if (
      event.blockerSetKey === null ||
      event.blockerSetKey !== attempt.blockerSetKey ||
      event.descriptorKey !== attempt.descriptorKey
    ) {
      break;
    }
    streak += 1;
  }
  return { blockedLoop: streak >= maxReturns, streak };
}

/** Order-independent signature of a blocker id set. */
export function blockerSetKeyOf(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(",");
}

/** Canonical (key-sorted) JSON of an unblock descriptor; null for none. */
export function descriptorKeyOf(descriptor: unknown): string | null {
  if (descriptor === null || descriptor === undefined) return null;
  return canonicalJson(descriptor);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The message of the 422 returned when the limiter rejects a return. */
export function blockedLoopMessage(maxReturns: number): string {
  return (
    `Blocked loop limit reached: ${maxReturns} consecutive returns to blocked without a blocker change. ` +
    "Express the external wait with an issue monitor (executionPolicy.monitor.nextCheckAt) or " +
    "unblockDescriptor.reasonRef kind=event/date instead of re-blocking."
  );
}
