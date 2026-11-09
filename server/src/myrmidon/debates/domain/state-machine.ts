// server/src/myrmidon/debates/domain/state-machine.ts
//
// myrmidon(1.7 DEBATE-ASYM, OPE-12076): the pure debate run state machine.
//
// Transitions: draft → in_progress → judge_verdict → done. The run collects
// round replies one round at a time; the round limit (max_rounds, default and
// hard cap 3) is enforced here; the judge never speaks inside a round — it is
// invoked only through concludeForJudge on the full collected transcript, and
// its verdict closes the run through applyVerdict.
//
// Plain data in, plain data out, no clock: every function either returns the
// next run or a DebateRunError with a stable code.

import type { DebateParticipant, DebateRun, DebateRunConfig, DebateStatement, DebateVerdict } from "./types.js";

/** The default and the hard cap of rounds in a debate run. */
export const DEBATE_RUN_MAX_ROUNDS = 3;
export const DEBATE_RUN_DEFAULT_MAX_ROUNDS = 3;

/** Stable error codes thrown by the state machine. */
export type DebateRunErrorCode =
  | "invalid_config"
  | "invalid_transition"
  | "rounds_exhausted"
  | "token_ceiling_exceeded"
  | "unknown_participant"
  | "judge_not_allowed_in_rounds"
  | "no_verdict_yet";

export class DebateRunError extends Error {
  readonly code: DebateRunErrorCode;

  constructor(code: DebateRunErrorCode, message: string) {
    super(message);
    this.name = "DebateRunError";
    this.code = code;
  }
}

export function normalizeMaxRounds(maxRounds: number): number {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new DebateRunError("invalid_config", `maxRounds must be a positive integer, got ${String(maxRounds)}`);
  }
  return Math.min(maxRounds, DEBATE_RUN_MAX_ROUNDS);
}

/**
 * Create a draft run. The run needs exactly one pro, one contra, and one
 * judge; the judge is registered but stays outside the dispute rounds.
 */
export function createDebateRun(input: {
  id: string;
  config: DebateRunConfig;
  participants: DebateParticipant[];
  prompts: { pro: string; contra: string };
}): DebateRun {
  const { id, config, participants, prompts } = input;
  if (!id) throw new DebateRunError("invalid_config", "a debate run needs an id");
  const pro = participants.find((p) => p.role === "pro");
  const contra = participants.find((p) => p.role === "contra");
  const judge = participants.find((p) => p.role === "judge");
  if (!pro || !contra || !judge) {
    throw new DebateRunError("invalid_config", "a debate run needs exactly one pro, one contra, and one judge");
  }
  const polarIds = new Set([pro.id, contra.id, judge.id]);
  if (polarIds.size !== 3) {
    throw new DebateRunError("invalid_config", "pro, contra, and judge must be distinct participants");
  }
  const maxRounds = normalizeMaxRounds(config.maxRounds);
  const participantsById: Record<string, DebateParticipant> = {};
  for (const participant of participants) {
    participantsById[participant.id] = participant;
  }
  return {
    id,
    state: "draft",
    question: config.question,
    proParticipantId: pro.id,
    contraParticipantId: contra.id,
    judgeParticipantId: judge.id,
    participants: participantsById,
    prompts,
    maxRounds,
    tokenCeiling: config.tokenCeiling,
    roundCount: 0,
    rounds: [],
    verdict: null,
    tokensUsed: 0,
  };
}

/** draft → in_progress. */
export function startDebateRun(run: DebateRun): DebateRun {
  if (run.state !== "draft") {
    throw new DebateRunError("invalid_transition", `a debate run starts from draft, not from ${run.state}`);
  }
  return { ...run, state: "in_progress" };
}

/** The tokens still available before the ceiling stops the run. */
export function remainingTokens(run: DebateRun): number | null {
  if (run.tokenCeiling === null) return null;
  return Math.max(0, run.tokenCeiling - run.tokensUsed);
}

/**
 * Collect one round of polar replies (the pro statement first, the contra
 * answer second). Only the run's two poles may speak; the judge is refused.
 * The round limit is enforced: no collection past maxRounds.
 */
export function collectRound(
  run: DebateRun,
  statements: { pro: Omit<DebateStatement, "round">; contra: Omit<DebateStatement, "round"> },
  spentTokens: { pro: number; contra: number },
): DebateRun {
  if (run.state !== "in_progress") {
    throw new DebateRunError("invalid_transition", `rounds are collected in in_progress, not in ${run.state}`);
  }
  if (run.roundCount >= run.maxRounds) {
    throw new DebateRunError("rounds_exhausted", `the debate ran its ${run.maxRounds} rounds; the judge speaks next`);
  }
  if (
    statements.pro.participantId === run.judgeParticipantId ||
    statements.contra.participantId === run.judgeParticipantId
  ) {
    throw new DebateRunError("judge_not_allowed_in_rounds", "the judge is outside the dispute and never speaks in a round");
  }
  if (statements.pro.participantId !== run.proParticipantId) {
    throw new DebateRunError("unknown_participant", `round ${run.roundCount} is not spoken by the pro participant`);
  }
  if (statements.contra.participantId !== run.contraParticipantId) {
    throw new DebateRunError("unknown_participant", `round ${run.roundCount} is not answered by the contra participant`);
  }
  const projected = run.tokensUsed + spentTokens.pro + spentTokens.contra;
  if (run.tokenCeiling !== null && projected > run.tokenCeiling) {
    throw new DebateRunError(
      "token_ceiling_exceeded",
      `round ${run.roundCount} would spend ${projected} tokens past the ceiling ${run.tokenCeiling}`,
    );
  }
  const round = {
    index: run.roundCount,
    pro: { ...statements.pro, round: run.roundCount },
    contra: { ...statements.contra, round: run.roundCount },
  };
  return {
    ...run,
    rounds: [...run.rounds, round],
    roundCount: run.roundCount + 1,
    tokensUsed: projected,
  };
}

/**
 * The dispute is over: hand the FULL transcript to the judge. The returned
 * transcript contains the question and every collected reply, in order, and
 * never a judge statement — the judge only receives, never argued.
 */
export function concludeForJudge(run: DebateRun): { transcript: DebateStatement[]; judgeParticipant: DebateParticipant } {
  if (run.state !== "in_progress") {
    throw new DebateRunError("invalid_transition", `the judge is concluded from in_progress, not from ${run.state}`);
  }
  if (run.roundCount < run.maxRounds) {
    throw new DebateRunError("invalid_transition", `the dispute needs all ${run.maxRounds} rounds before the judge`);
  }
  const judge = run.participants[run.judgeParticipantId];
  if (!judge || judge.role !== "judge") {
    throw new DebateRunError("unknown_participant", "the run has no judge participant to conclude to");
  }
  const transcript = run.rounds.flatMap((round) => [round.pro, round.contra]);
  return { transcript, judgeParticipant: judge };
}

/** in_progress → judge_verdict: record the judge's verdict text. */
export function recordVerdict(run: DebateRun, verdictText: string, verdictTokens: number): DebateRun {
  if (run.state !== "in_progress") {
    throw new DebateRunError("invalid_transition", `a verdict is recorded in in_progress, not in ${run.state}`);
  }
  if (run.roundCount < run.maxRounds) {
    throw new DebateRunError("invalid_transition", `the verdict needs all ${run.maxRounds} rounds collected`);
  }
  const projected = run.tokensUsed + verdictTokens;
  if (run.tokenCeiling !== null && projected > run.tokenCeiling) {
    throw new DebateRunError(
      "token_ceiling_exceeded",
      `the verdict call would spend ${projected} tokens past the ceiling ${run.tokenCeiling}`,
    );
  }
  const verdict: DebateVerdict = { participantId: run.judgeParticipantId, text: verdictText };
  return { ...run, state: "judge_verdict", verdict, tokensUsed: projected };
}

/** judge_verdict → done: close the run with its verdict kept. */
export function completeDebateRun(run: DebateRun): DebateRun {
  if (run.state !== "judge_verdict") {
    throw new DebateRunError("invalid_transition", `a debate run completes from judge_verdict, not from ${run.state}`);
  }
  if (run.verdict === null) {
    throw new DebateRunError("no_verdict_yet", "a debate run completes only with a verdict");
  }
  return { ...run, state: "done" };
}
