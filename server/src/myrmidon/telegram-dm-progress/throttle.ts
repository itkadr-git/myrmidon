// server/src/myrmidon/telegram-dm-progress/throttle.ts
//
// myrmidon(DM-PROGRESS): when the live Telegram DM status message may be
// edited again. Pure: the caller passes the stored row's text and its last
// update time, and the freshly composed text.
//
// Rules, in order:
// 1. no row yet → publish (the first status post);
// 2. same text → never (no duplicate edits);
// 3. milestone changed (queued → working) → publish at once;
// 4. the KIND of the current step changed (reading → editing → checking) →
//    publish once at least `minStepChangeMs` (a few seconds, Telegram's
//    per-message edit limit) passed since the last edit;
// 5. anything else (the same kind with a new target, the elapsed-time line,
//    the finished-steps list) → publish only once `intervalMs` passed.
// The elapsed-time bucket alone therefore never edits faster than the
// interval.

/** The floor between two edits even when the step kind changes. */
export const DM_PROGRESS_MIN_STEP_CHANGE_MS = 5_000;

export type DmStatusPublishReason =
  | "first"
  | "unchanged"
  | "milestone_changed"
  | "step_kind_changed"
  | "step_kind_floor"
  | "interval_elapsed"
  | "throttled";

export interface DmStatusPublishDecision {
  publish: boolean;
  reason: DmStatusPublishReason;
}

const ELAPSED_SUFFIX = / · (?:<1 мин|\d+ мин|\d+ ч \d+ мин)$/;

/**
 * The kind of the current step shown in a status text: the first word of the
 * headline after the agent name, with the elapsed-time suffix removed
 * ("Агент: правлю слайды 4, 9 · 3 мин" → "правлю"). The status labels start
 * with a verb per kind, so the verb is the kind. Null for an empty text.
 */
export function dmStatusStepKind(text: string, agentName: string): string | null {
  const headline = (text.split("\n")[0] ?? "").replace(ELAPSED_SUFFIX, "").trim();
  if (!headline) return null;
  const prefix = `${agentName}: `;
  const label = headline.startsWith(prefix) ? headline.slice(prefix.length) : headline;
  const word = label.trim().split(/\s+/)[0] ?? "";
  return word ? word.toLowerCase() : null;
}

export function decideDmStatusPublish(input: {
  previousText: string | null;
  previousMilestone: string | null;
  nextText: string;
  nextMilestone: string;
  agentName: string;
  lastEditAt: Date | null;
  now: Date;
  intervalMs: number;
  minStepChangeMs?: number;
}): DmStatusPublishDecision {
  if (input.previousText === null) return { publish: true, reason: "first" };
  if (input.previousText === input.nextText) return { publish: false, reason: "unchanged" };
  if (input.previousMilestone !== input.nextMilestone) {
    return { publish: true, reason: "milestone_changed" };
  }
  const sinceLastEditMs = input.lastEditAt
    ? input.now.getTime() - input.lastEditAt.getTime()
    : Number.POSITIVE_INFINITY;
  const floorMs = input.minStepChangeMs ?? DM_PROGRESS_MIN_STEP_CHANGE_MS;
  const previousKind = dmStatusStepKind(input.previousText, input.agentName);
  const nextKind = dmStatusStepKind(input.nextText, input.agentName);
  if (previousKind !== nextKind) {
    return sinceLastEditMs >= floorMs
      ? { publish: true, reason: "step_kind_changed" }
      : { publish: false, reason: "step_kind_floor" };
  }
  return sinceLastEditMs >= input.intervalMs
    ? { publish: true, reason: "interval_elapsed" }
    : { publish: false, reason: "throttled" };
}
