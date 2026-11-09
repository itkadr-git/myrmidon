// server/src/myrmidon/debates/domain/types.ts
//
// myrmidon(1.7 DEBATE-ASYM, OPE-12076): the domain types of the asymmetric
// debate state machine — a fresh, pure state layer for the round-based debate
// wave (roadmap-v1 §3.3).
//
// Difference from the existing engine contract (myrmidon-debate.ts): there the
// roles are generator/critic/judge and the engine runs the whole debate in one
// call. Here the debate is an explicit persisted run: two polar participants
// argue in rounds (pro / contra), a judge sits outside the dispute and is only
// called when the run reaches the verdict stage, and the run advances through
// explicit states (draft → in_progress → judge_verdict → done).
//
// Plain data in, plain data out: no drizzle, no services, no Node I/O, no
// clock — this file is the vocabulary the state machine (state-machine.ts)
// and the later schema/store wiring build on.

/**
 * The role of a debate participant.
 *
 * `pro` and `contra` are the two polar sides of the dispute; `judge` is the
 * arbiter outside the dispute: it never speaks in a pro/contra round and is
 * invoked once, on the full transcript, at the verdict stage.
 */
export type DebateParticipantRole = "pro" | "contra" | "judge";

/** Every model id is an opaque non-empty string (env-provided, never hardcoded). */
export type DebateModelId = string;

/** One participant of a debate run: a polar side, or the judge. */
export interface DebateParticipant {
  /** Stable identifier, unique within its run. */
  id: string;
  role: DebateParticipantRole;
  /** The model that speaks for this participant (from configuration/env). */
  model: DebateModelId;
}

/**
 * The lifecycle of a debate run.
 *
 * draft → in_progress → judge_verdict → done.
 */
export const DEBATE_RUN_STATES = ["draft", "in_progress", "judge_verdict", "done"] as const;

export type DebateRunState = (typeof DEBATE_RUN_STATES)[number];

/** One reply inside a round, spoken by a polar participant. */
export interface DebateStatement {
  /** Who spoke: a participant id of the run (never the judge's). */
  participantId: string;
  /** The zero-based round the statement belongs to. */
  round: number;
  /** The reply text as produced by the participant's model. */
  text: string;
}

/** A collected round: both polar sides spoke, in a stable order. */
export interface DebateRound {
  /** Zero-based round index (0 … maxRounds − 1). */
  index: number;
  /** The pro side's reply of this round. */
  pro: DebateStatement;
  /** The contra side's reply of this round. */
  contra: DebateStatement;
}

/** The judge's verdict, delivered once after the dispute rounds close. */
export interface DebateVerdict {
  /** The judge participant id (the run's judge, never a polar side). */
  participantId: string;
  /** The verdict text as produced by the judge's model. */
  text: string;
}

/** The static configuration a debate run is created with. */
export interface DebateRunConfig {
  /** The question under dispute; non-empty. */
  question: string;
  /** The round limit; the domain default is 3 and it is hard-capped at 3. */
  maxRounds: number;
  /**
   * The total token budget for the whole run (all rounds + the verdict call).
   * Null means no ceiling.
   */
  tokenCeiling: number | null;
}

/** A debate run: participants, the polar prompt, rounds, and the verdict. */
export interface DebateRun {
  id: string;
  state: DebateRunState;
  question: string;
  /** The participant ids that argue, by pole. */
  proParticipantId: string;
  contraParticipantId: string;
  /** The judge participant id, outside the dispute. */
  judgeParticipantId: string;
  /** All participants keyed by id (pro, contra, judge). */
  participants: Record<string, DebateParticipant>;
  /** Polar system prompts: what each pole is told to defend/attack. */
  prompts: { pro: string; contra: string };
  maxRounds: number;
  tokenCeiling: number | null;
  /** How many rounds have been fully collected so far (0 … maxRounds). */
  roundCount: number;
  /** Fully collected rounds, in order. */
  rounds: DebateRound[];
  /** The judge's verdict, set exactly once, in the judge_verdict stage. */
  verdict: DebateVerdict | null;
  /** Tokens spent so far across all model calls of the run. */
  tokensUsed: number;
}
