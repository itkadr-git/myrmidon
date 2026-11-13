// myrmidon(OPE-13021): agent response-probe liveness.
//
// A heartbeat process being alive ("the adapter spawned, the gateway answers
// /api/health") is not the same as the agent actually answering on the model.
// This module derives an honest liveness status from three durable facts:
//
//   - `lastProbeAt` / `lastProbeOutcome` — the process probe (gateway
//     `GET /api/health`-class health check) result recorded by the probe
//     writer;
//   - `lastResponseAt` — the last time the model actually produced work
//     (tokens spent or a model response started).
//
// It is a pure function: no DB, no clock reads, so verticals B (queue
// detector), C (ladder/journal) and D (settings/UI) can reuse it.
//
// The derived status is a SEPARATE field from `AgentStatus`
// (packages/shared/src/constants.ts): it never replaces or contradicts the
// operational status — a paused agent that last answered two minutes ago is
// still `paused` and reads `answering` here.

/** Outcome of the last process probe against the agent's runtime. */
export type AgentProbeOutcome = "ok" | "unreachable";

export const AGENT_PROBE_OUTCOMES: readonly AgentProbeOutcome[] = [
  "ok",
  "unreachable",
];

/**
 * The honest "is the agent actually answering" status, derived from the last
 * probe and the last model response. `null` when nothing is known yet (no
 * probe and no response ever recorded).
 */
export type AgentDerivedStatus =
  | "answering"
  | "alive_but_not_answering"
  | "unreachable"
  | null;

export interface AgentLivenessInput {
  /** Last process-probe time, null when never probed. */
  lastProbeAt: Date | null;
  /** Last probe outcome; null when never probed. */
  lastProbeOutcome: AgentProbeOutcome | string | null;
  /** Last time the model produced work (tokens spent or response started). */
  lastResponseAt: Date | null;
  /** Wall clock of the derivation, injected for purity. */
  now: Date;
}

/**
 * `true` when the agent answered on the model within `answerFreshWindowMs` of
 * `now`. 10 minutes: a long thinking/tool turn can legitimately produce no
 * tokens for minutes, and a live-model heartbeat cadence is far below this.
 */
export const AGENT_ANSWER_FRESH_WINDOW_MS = 10 * 60 * 1000;

export function isAgentResponseFresh(lastResponseAt: Date | null, now: Date): boolean {
  if (!lastResponseAt) return false;
  return now.getTime() - lastResponseAt.getTime() <= AGENT_ANSWER_FRESH_WINDOW_MS;
}

/**
 * Derive the probe liveness status.
 *
 * Rules, first match wins:
 *  - never probed and never answered → `null` (unknown, no UI claim);
 *  - last probe failed → `unreachable` (the runtime is down — even a fresh
 *    response cannot make a dead process "answering" again);
 *  - fresh model response → `answering`;
 *  - probe passed but no fresh response → `alive_but_not_answering`;
 *  - never probed, stale response only → `answering` is not claimable, and
 *    without a probe the runtime state is unknown, so `null`.
 */
export function deriveAgentProbeStatus(input: AgentLivenessInput): AgentDerivedStatus {
  const outcome = input.lastProbeOutcome ?? null;
  if (!input.lastProbeAt && !outcome && !input.lastResponseAt) return null;
  if (outcome === "unreachable") return "unreachable";
  if (outcome === "ok" || input.lastProbeAt) {
    return isAgentResponseFresh(input.lastResponseAt, input.now)
      ? "answering"
      : "alive_but_not_answering";
  }
  return null;
}
