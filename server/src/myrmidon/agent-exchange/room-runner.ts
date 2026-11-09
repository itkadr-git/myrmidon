// server/src/myrmidon/agent-exchange/room-runner.ts
//
// myrmidon(1.7-AGENT-EXCHANGE, OPE-12079): the round runner — the part of the
// room engine that decides what each participant sees in a round and what the
// round costs, extracted from engine.ts so the first-round rule has its own
// home and its own unit tests.
//
// The rule this module exists for (roadmap-v1 §3.3): ROUND 1 IS INDEPENDENT.
// Every participant's round-1 prompt is the opening prompt alone — a
// participant never sees another participant's answer before all first
// replies have landed, so the room cannot become an echo chamber. From round
// 2 on, a participant's prompt includes the previous round's landed answers.
//
// The runner also owns the money: one `runRound` returns the tokens and cents
// the round consumed, and `sumRoundTotals` folds the per-call totals into the
// room total (tokens * rate, summed over ALL participants). Cost of one call
// is `agentExchangeCallCostCents` from @myrmidon/shared; a model without a
// catalog price costs 0 — the room never invents a price.

import type {
  AgentExchangeMessage,
  AgentExchangeParticipantSpec,
} from "@myrmidon/shared";

/** The user prompt of one participant call. Round 1 sees the opening prompt ONLY. */
export function buildParticipantPrompt(input: {
  round: number;
  openingPrompt: string;
  previousRoundAnswers: string[];
}): string {
  if (input.round === 1) return input.openingPrompt;
  return [
    input.openingPrompt,
    "",
    `Round ${input.round - 1} answers:`,
    ...input.previousRoundAnswers,
    "",
    `Round ${input.round}: reply to the answers above — where do you agree, where do you differ?`,
  ].join("\n");
}

/**
 * The previous round's landed answers, labeled per participant. Only `done`
 * answers with content enter the transcript: a failed or still-pending
 * participant simply does not speak in the next round's context.
 */
export function collectPreviousRoundAnswers(input: {
  messages: AgentExchangeMessage[];
  round: number;
  participants: AgentExchangeParticipantSpec[];
}): string[] {
  return input.messages
    .filter((m) => m.round === input.round && m.status === "done" && m.content)
    .map(
      (m) =>
        `${input.participants[m.participantIndex]?.label ?? `participant-${m.participantIndex}`}: ${m.content}`,
    );
}

/** The running total a round accumulates: tokens and cents across calls. */
export interface RoundTotals {
  tokens: number;
  costCents: number;
}

export const EMPTY_ROUND_TOTALS: RoundTotals = { tokens: 0, costCents: 0 };

/**
 * Fold per-call totals into one room-round total. This is the summation the
 * acceptance test pins: the room total is the sum over ALL participants'
 * calls (each call = tokens * rate from `agentExchangeCallCostCents`).
 */
export function sumRoundTotals(parts: Array<{ tokens: number; costCents: number }>): RoundTotals {
  return parts.reduce(
    (acc, part) => ({ tokens: acc.tokens + part.tokens, costCents: acc.costCents + part.costCents }),
    { ...EMPTY_ROUND_TOTALS },
  );
}
