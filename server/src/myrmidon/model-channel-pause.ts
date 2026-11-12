/**
 * OPE-12800: one growing pause per AGENT after its model channel fails, shared
 * by every wake reason.
 *
 * A run that fails before the model answered (the gateway returned HTTP 5xx,
 * the provider is out of quota, the model is unavailable) says nothing about
 * the task: it says the agent's channel to the model is down. The bounded
 * transient retry counts attempts per RUN CHAIN (two retries, 30 s apart), so
 * every new wake of the agent (idle pickup, swarm match, timer) started a new
 * chain from zero and the agent produced three failed runs every few minutes
 * for as long as the channel stayed down (11.11.2026: 8 336 runs of 12 agents
 * in 15 hours, none of which reached the model).
 *
 * The pause is derived from the agent's own recent finished runs, so it needs
 * no stored state and survives a restart of the board:
 *
 * - the streak is the number of consecutive channel failures at the head of
 *   the agent's history (newest first);
 * - the pause lasts `MODEL_CHANNEL_PAUSE_LADDER_MS[streak - 1]` (the last step
 *   is the ceiling) counted from the end of the newest failure;
 * - any run in which the model answered (succeeded, `modelResponseStarted`,
 *   or tokens were spent) ends the streak: the next failure starts from the
 *   first step again;
 * - runs that say nothing about the channel (cancelled before start, a
 *   workspace error, the agent's own gateway being busy or unreachable) are
 *   skipped: they neither extend nor end the streak;
 * - two failures further apart than `MODEL_CHANNEL_STREAK_MAX_GAP_MS` are two
 *   separate outages, not one streak.
 *
 * While the pause holds, the heartbeat service does not start runs of the
 * agent (see `getAgentModelChannelPause` in services/heartbeat.ts). The first
 * run after the pause is the probe: if it fails, the pause grows; if the model
 * answers, the pause is gone.
 */

const MINUTE_MS = 60 * 1000;

/** Pause after the 1st, 2nd, ... consecutive channel failure. The last step is the ceiling. */
export const MODEL_CHANNEL_PAUSE_LADDER_MS: readonly number[] = [
  1 * MINUTE_MS,
  2 * MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
  30 * MINUTE_MS,
];

/** Failures further apart than this belong to different outages. */
export const MODEL_CHANNEL_STREAK_MAX_GAP_MS = 2 * 60 * MINUTE_MS;

/** How far back the caller has to read the agent's runs for the streak to be complete. */
export const MODEL_CHANNEL_PAUSE_LOOKBACK_MS = 6 * 60 * MINUTE_MS;

/** How many of the newest finished runs are enough (the ladder has five steps). */
export const MODEL_CHANNEL_PAUSE_LOOKBACK_RUNS = 40;

/** Upper bound of the random delay added to the due time of a run parked behind the pause. */
export const MODEL_CHANNEL_PAUSE_JITTER_MS = 15 * 1000;

/** Key of the context marker of a run parked behind the pause. */
export const MODEL_CHANNEL_PAUSE_CONTEXT_KEY = "modelChannelPause";

/**
 * Wake reasons that only poll for work and carry no event of their own: the
 * next tick of the same source repeats them, so during the pause they are
 * dropped before a wake row or a run is created. Every other automatic wake
 * carries an event (assignment, comment, retry) and is kept: its run is parked
 * until the pause ends.
 */
export const MODEL_CHANNEL_PAUSE_POLL_WAKE_REASONS: readonly string[] = [
  "idle_pickup",
  "heartbeat_timer",
];

/** Error families the adapters report when the provider side of the model call failed. */
const MODEL_CHANNEL_ERROR_FAMILIES = new Set(["transient_upstream", "provider_quota"]);

/**
 * Failures of the agent's OWN gateway, not of the model channel: each has a
 * retry ladder of its own in the heartbeat service (busy 429 with Retry-After,
 * connect failures, the predecessor run still alive).
 */
const NOT_MODEL_CHANNEL_ERROR_CODES = new Set([
  "hermes_gateway_connect_failed",
  "hermes_gateway_rate_limited",
  "hermes_gateway_predecessor_running",
]);

export type ModelChannelRunFacts = {
  status: string;
  errorCode?: string | null;
  finishedAt: Date | null;
  /** `resultJson.errorFamily` */
  errorFamily?: string | null;
  /** `resultJson.modelResponseStarted === true` */
  modelResponseStarted?: boolean | null;
  /** `resultJson.model_unavailable === true` */
  modelUnavailable?: boolean | null;
  /** `usageJson.inputTokens` */
  inputTokens?: number | null;
  /** `usageJson.outputTokens` */
  outputTokens?: number | null;
};

export type ModelChannelRunVerdict = "channel_failure" | "model_answered" | "neutral";

function positive(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** What one finished run says about the agent's model channel. */
export function classifyModelChannelRun(run: ModelChannelRunFacts): ModelChannelRunVerdict {
  if (!run.finishedAt || !Number.isFinite(run.finishedAt.getTime())) return "neutral";
  const modelAnswered =
    run.modelResponseStarted === true || positive(run.inputTokens) || positive(run.outputTokens);
  if (run.status === "succeeded" || modelAnswered) return "model_answered";
  if (run.status !== "failed") return "neutral";
  if (run.errorCode && NOT_MODEL_CHANNEL_ERROR_CODES.has(run.errorCode)) return "neutral";
  if (run.modelUnavailable === true) return "channel_failure";
  if (run.errorFamily && MODEL_CHANNEL_ERROR_FAMILIES.has(run.errorFamily)) return "channel_failure";
  return "neutral";
}

/** The pause for the given number of consecutive failures (0 for none). */
export function modelChannelPauseDelayMs(streak: number): number {
  if (!Number.isFinite(streak) || streak < 1) return 0;
  const index = Math.min(Math.floor(streak), MODEL_CHANNEL_PAUSE_LADDER_MS.length) - 1;
  return MODEL_CHANNEL_PAUSE_LADDER_MS[index]!;
}

export type ModelChannelPause = {
  /** Consecutive channel failures at the head of the agent's history. */
  streak: number;
  delayMs: number;
  /** End of the newest failure: the pause is counted from it. */
  lastFailureAt: Date;
  pauseUntil: Date;
};

/**
 * The pause in force at `now` for an agent with these finished runs (any
 * order), or null when the agent may run. Pure: no clock, no database.
 */
export function computeModelChannelPause(
  runs: readonly ModelChannelRunFacts[],
  now: Date,
): ModelChannelPause | null {
  const finished = runs
    .filter((run) => run.finishedAt && Number.isFinite(run.finishedAt.getTime()))
    .sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime());
  let streak = 0;
  let lastFailureAt: Date | null = null;
  let previousFailureMs: number | null = null;
  for (const run of finished) {
    const verdict = classifyModelChannelRun(run);
    if (verdict === "neutral") continue;
    if (verdict === "model_answered") break;
    const finishedMs = run.finishedAt!.getTime();
    if (previousFailureMs !== null && previousFailureMs - finishedMs > MODEL_CHANNEL_STREAK_MAX_GAP_MS) {
      break;
    }
    streak += 1;
    lastFailureAt ??= run.finishedAt!;
    previousFailureMs = finishedMs;
  }
  if (streak === 0 || !lastFailureAt) return null;
  const delayMs = modelChannelPauseDelayMs(streak);
  const pauseUntil = new Date(lastFailureAt.getTime() + delayMs);
  if (pauseUntil.getTime() <= now.getTime()) return null;
  return { streak, delayMs, lastFailureAt, pauseUntil };
}

/**
 * Whether a wake is held by the pause at all. A wake made by a user (a manual
 * wake, a comment, a chat message) is an explicit request: it runs at once and
 * doubles as a probe of the channel.
 */
export function isWakeSubjectToModelChannelPause(input: {
  manualUserWake?: boolean | null;
  requestedByActorType?: string | null;
}): boolean {
  return input.manualUserWake !== true && input.requestedByActorType !== "user";
}

/** Whether a wake of this reason is a poll that the pause drops instead of parking. */
export function isModelChannelPausePollWake(reason: string | null | undefined): boolean {
  return typeof reason === "string" && MODEL_CHANNEL_PAUSE_POLL_WAKE_REASONS.includes(reason);
}

/** When a run parked behind the pause falls due: the end of the pause plus a small jitter. */
export function computeModelChannelPauseDueAt(pauseUntil: Date, random: () => number = Math.random): Date {
  const raw = random();
  const sample = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
  return new Date(pauseUntil.getTime() + Math.floor(sample * MODEL_CHANNEL_PAUSE_JITTER_MS));
}
