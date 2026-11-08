// server/src/myrmidon/debates/round-runner.ts
//
// myrmidon(1.7 DEBATE-ASYM §3.3, OPE-12077): the debate round service.
//
// Where `runDebate` (packages/shared/src/myrmidon-debate.ts) drives a whole
// debate in ONE call, this module runs it ROUND BY ROUND: a stateful runner
// that collects the two participants' replies for round N on demand, enforces
// the token ceiling at every step, and — once the last planned round is
// collected — hands the FULL, verbatim context to the judge, who sits outside
// the dispute. It exists so a caller (the route/store wiring of a later wave
// subtask) can persist the runner state between rounds instead of holding one
// long engine call open.
//
// The roadmap contract, mapped onto the part-A engine vocabulary:
//   - participants A and B are the generator (constructive pole) and the
//     critic (adversarial pole);
//   - round 1 collects the PARALLEL first answers: both reply to the bare
//     question and neither sees the other (the owner rule the engine keeps).
//     The two calls are issued in a fixed A-then-B order so the transcript,
//     the ceiling accounting and the tests stay deterministic — "parallel"
//     here is the independence of the replies, not concurrent requests;
//   - rounds 2..maxRounds are the exchange: A revises against B's latest
//     position, then B attacks A's revised answer. B's reply carrying
//     [AGREE] is surfaced on the round record as the stop signal, so the
//     caller can skip the remaining rounds and go straight to the judge;
//   - the token ceiling is enforced twice, exactly like the engine: a
//     projected exchange call that would cross the remaining ceiling is
//     refused BEFORE being made, and a call that reveals a crossing only
//     after running is still recorded (its cost lands in
//     `ceilingCrossedCents`, never charged) and the round is interrupted —
//     the next round is then refused;
//   - at round = maxRounds the full context (the question plus every
//     collected reply, verbatim and in order) is built into the judge prompt
//     — no truncation, no paraphrase — and `runJudge()` puts it in front of
//     the judge through the same mockable `call` port the engine uses. The
//     judge always keeps its turn once the two independent first answers are
//     in, even when a later exchange round was cut short by the ceiling.
//
// No LLM lives here: every model call comes in through `DebateModelCall`,
// so the whole service runs verbatim in tests with fakes (see
// round-runner.myrmidon.test.ts).

import {
  composeRoleSystemPrompt,
  criticAgrees,
  debateCallCostCents,
  DEBATE_AGREE_MARKER,
  DEBATE_DEFAULT_ROUNDS,
  DEBATE_DEFAULT_TOKEN_CEILING,
  getModelFamily,
  type DebateModelCall,
  type DebatePromptOverrides,
  type DebateRole,
  type DebateRoleConfig,
  type DebateSettings,
  type DebateTurn,
} from "@myrmidon/shared";

/** Participants of the dispute: A = generator (constructive), B = critic (adversarial). */
export const DEBATE_PARTICIPANT_A: DebateRole = "generator";
export const DEBATE_PARTICIPANT_B: DebateRole = "critic";

/**
 * The allowance the engine projects for an exchange call before making it.
 * Mirrors the engine's PROJECTED_CALL_TOKENS so both contours stop a debate
 * at the same point when the ceiling runs out.
 */
export const DEBATE_PROJECTED_CALL_TOKENS = 4000;

/** Error codes of the round service. */
export type DebateRoundErrorCode = "round_order" | "round_interrupted" | "judge_not_ready" | "judge_called" | "bad_question";

/** One rule violation of the round loop, with a stable code for the caller. */
export class DebateRoundError extends Error {
  readonly code: DebateRoundErrorCode;
  constructor(code: DebateRoundErrorCode, message: string) {
    super(message);
    this.name = "DebateRoundError";
    this.code = code;
  }
}

export interface DebateRoundRunnerInput {
  /** The question under debate; trimmed, capped at 2000 chars like the service does. */
  question: string;
  /** The effective role configuration (already resolved, family rule included). */
  settings: DebateSettings;
  /** The model call port — the gateway in production, fakes in tests. */
  call: DebateModelCall;
  /** Custom per-role guidance appended to the built-in pole prompt (part B). */
  prompts?: DebatePromptOverrides;
}

/** What one `collectRound` produced. */
export interface DebateRoundRecord {
  round: number;
  /**
   * The replies collected this round, in call order (A, then B). A reply that
   * crossed the ceiling is here too — the call ran and is recorded, its cost
   * is not charged.
   */
  turns: DebateTurn[];
  /** True when the token ceiling cut the round short (fewer than two charged replies). */
  interrupted: boolean;
  /** Why the round stopped short, in human terms; null when it completed. */
  stopDetail: string | null;
  /** B's reply carried the agreement marker — the caller may skip the remaining rounds. */
  criticAgreed: boolean;
}

/** The full, verbatim context handed to the judge at round = maxRounds. */
export interface DebateJudgeContext {
  question: string;
  /** Every collected reply, verbatim, in collection order. */
  turns: readonly DebateTurn[];
  /** The exact transcript text embedded in the judge prompt. */
  transcriptText: string;
}

export class DebateRoundRunner {
  /** The question under debate (trimmed, capped at 2000 chars). */
  readonly question: string;
  /** Planned rounds, 1..3 (settings value or the default). */
  readonly maxRounds: number;
  /** Total-token ceiling across the whole debate (settings value or the default). */
  readonly tokenCeiling: number;

  private readonly settings: DebateSettings;
  private readonly call: DebateModelCall;
  private readonly prompts: DebatePromptOverrides;
  private readonly transcript: DebateTurn[] = [];

  private roundsCollectedCount = 0;
  private tokensUsedCount = 0;
  private totalCentsCount = 0;
  private ceilingCrossedCentsCount = 0;
  private interruptedFlag = false;
  private interruptDetail: string | null = null;
  private firstAnswersCollected = false;
  private judgeAttempted = false;
  private judgeVerdictText: string | null = null;
  private lastAnswerA: string | null = null;
  private lastAnswerB: string | null = null;

  constructor(input: DebateRoundRunnerInput) {
    const question = input.question.trim().slice(0, 2000);
    if (!question) {
      throw new DebateRoundError("bad_question", "the debate question is empty");
    }
    this.question = question;
    this.settings = input.settings;
    this.call = input.call;
    this.prompts = input.prompts ?? {};
    this.maxRounds = input.settings.rounds ?? DEBATE_DEFAULT_ROUNDS;
    this.tokenCeiling = input.settings.tokenCeiling ?? DEBATE_DEFAULT_TOKEN_CEILING;
  }

  /** Rounds whose full pair of replies was collected so far. */
  get roundsCollected(): number {
    return this.roundsCollectedCount;
  }

  /** Tokens charged against the ceiling so far (an overrun call is not charged). */
  get tokensUsed(): number {
    return this.tokensUsedCount;
  }

  /** Cents charged so far (free models price at 0 and still count tokens). */
  get totalCents(): number {
    return this.totalCentsCount;
  }

  /** Cents of the call that crossed the ceiling — recorded, never charged. */
  get ceilingCrossedCents(): number {
    return this.ceilingCrossedCentsCount;
  }

  /** True when the ceiling cut a round short; the next round is refused. */
  get interrupted(): boolean {
    return this.interruptedFlag;
  }

  /** Every collected reply so far, verbatim, in collection order. */
  get turns(): readonly DebateTurn[] {
    return [...this.transcript];
  }

  /**
   * The judge can take the transcript once the two independent first answers
   * are in — exactly the engine's precondition ("the judge is the outside
   * arbiter and always gets its turn" after round 1). A later exchange round
   * cut short by the ceiling does not take this away.
   */
  get judgeReady(): boolean {
    return this.firstAnswersCollected;
  }

  /** The judge's verdict, once `runJudge` recorded one. */
  get judgeVerdict(): string | null {
    return this.judgeVerdictText;
  }

  /**
   * Collect the two participants' replies for round N. Rounds are strictly
   * ordered: the runner accepts only `roundsCollected + 1`, refuses anything
   * past `maxRounds`, and refuses to continue after an interrupted round.
   */
  async collectRound(round: number): Promise<DebateRoundRecord> {
    if (!Number.isInteger(round) || round < 1) {
      throw new DebateRoundError("round_order", "debate rounds are counted from 1");
    }
    if (round > this.maxRounds) {
      throw new DebateRoundError("round_order", `the debate has at most ${this.maxRounds} round(s); round ${round} was requested`);
    }
    if (this.interruptedFlag) {
      throw new DebateRoundError("round_interrupted", this.interruptDetail ?? "the previous round was interrupted by the token ceiling");
    }
    if (round !== this.roundsCollectedCount + 1) {
      throw new DebateRoundError("round_order", `round ${round} is out of order: the next round to collect is ${this.roundsCollectedCount + 1}`);
    }

    const record: DebateRoundRecord = { round, turns: [], interrupted: false, stopDetail: null, criticAgreed: false };
    const independent = round === 1;

    for (const role of [DEBATE_PARTICIPANT_A, DEBATE_PARTICIPANT_B]) {
      // Pre-check (exchange rounds only, like the engine): a projected call
      // that would cross the remaining ceiling is refused without being made.
      if (!independent && this.tokensUsedCount + DEBATE_PROJECTED_CALL_TOKENS > this.tokenCeiling) {
        record.interrupted = true;
        record.stopDetail = `stopped before ${role}'s turn in round ${round}: only ${this.tokenCeiling - this.tokensUsedCount} tokens of the ${this.tokenCeiling} ceiling remain`;
        break;
      }
      const userPrompt = independent
        ? `Question: ${this.question}`
        : role === DEBATE_PARTICIPANT_A
          ? `Question: ${this.question}\n\nThe critic's position:\n${this.lastAnswerB ?? ""}\n\nRevise or defend your answer.`
          : `Question: ${this.question}\n\nThe generator's current answer:\n${this.lastAnswerA ?? ""}\n\nAttack it: list the errors, omissions and risks you find. If nothing remains unresolved, write ${DEBATE_AGREE_MARKER}.`;
      const turn = await this.runTurn(role, round, independent, userPrompt);
      if (turn === null) {
        // The call ran and crossed the ceiling: recorded, not charged, stop.
        record.interrupted = true;
        record.stopDetail = `the token ceiling (${this.tokenCeiling}) was crossed in round ${round} (${role} call)`;
        break;
      }
      record.turns.push(turn);
      if (role === DEBATE_PARTICIPANT_A) {
        this.lastAnswerA = turn.text;
      } else {
        this.lastAnswerB = turn.text;
        if (criticAgrees(turn.text)) record.criticAgreed = true;
      }
    }

    if (record.interrupted) {
      this.interruptedFlag = true;
      this.interruptDetail = record.stopDetail;
    } else {
      this.roundsCollectedCount = round;
    }
    // The judge keeps its turn once both independent first answers are in the
    // transcript — the engine's owner rule. A round-1 reply that crossed the
    // ceiling is recorded (uncharged) but is not an answer, so the flag tracks
    // the charged transcript: after a clean round 1 this is a no-op, after an
    // interrupted round 1 it still turns on when both first answers are there.
    if (
      this.transcript.some((turn) => turn.independent && turn.role === DEBATE_PARTICIPANT_A) &&
      this.transcript.some((turn) => turn.independent && turn.role === DEBATE_PARTICIPANT_B)
    ) {
      this.firstAnswersCollected = true;
    }
    return record;
  }

  /**
   * The full context for the judge: the question plus every collected reply,
   * verbatim and in order — the §3.3 "without distortion" rule. Safe from the
   * moment round 1 is collected (a partial transcript is exactly what the
   * engine would send when the debate stopped early).
   */
  buildJudgeContext(): DebateJudgeContext {
    return {
      question: this.question,
      turns: this.turns,
      transcriptText: this.transcript.map(transcriptLine).join("\n\n"),
    };
  }

  /**
   * The judge prompt: the same shape the engine sends — question, transcript,
   * the ask for a verdict — with the judge's own system prompt keeping it
   * outside the dispute (see `composeRoleSystemPrompt("judge")`).
   */
  buildJudgePrompt(): string {
    const { question, transcriptText } = this.buildJudgeContext();
    return `Question: ${question}\n\nDebate transcript:\n\n${transcriptText}\n\nDeliver your verdict and answer.`;
  }

  /**
   * Call the judge with the full context. One attempt per debate; the verdict
   * is recorded on the runner. A judge call that crosses the ceiling is
   * recorded (uncharged) and yields null — the engine's "the verdict could
   * not be recorded" outcome.
   */
  async runJudge(): Promise<DebateTurn | null> {
    if (!this.judgeReady) {
      throw new DebateRoundError("judge_not_ready", "the judge takes the transcript only after the two independent first answers are collected");
    }
    if (this.judgeAttempted) {
      throw new DebateRoundError("judge_called", "the judge has already been called for this debate");
    }
    this.judgeAttempted = true;
    const turn = await this.runTurn("judge", this.roundsCollectedCount, false, this.buildJudgePrompt());
    if (turn === null) {
      this.interruptDetail = `the token ceiling (${this.tokenCeiling}) was crossed at the judge call; the verdict could not be recorded`;
      this.interruptedFlag = true;
      return null;
    }
    this.judgeVerdictText = turn.text;
    return turn;
  }

  /**
   * One model call, the engine's bookkeeping verbatim: usage accounted against
   * the ceiling after the call (an overrun is recorded uncharged and reported
   * as null), cost by the shared cents rule, the turn appended to the
   * transcript either way.
   */
  private async runTurn(role: DebateRole, round: number, independent: boolean, userPrompt: string): Promise<DebateTurn | null> {
    const roleConfig: DebateRoleConfig = this.settings[role];
    const system = composeRoleSystemPrompt(role, this.prompts[role] ?? null);
    const res = await this.call(roleConfig, system, userPrompt, { role, round, independent });
    const usage = res.usage;
    const turn: DebateTurn = {
      role,
      round,
      independent,
      model: roleConfig.model,
      family: getModelFamily(roleConfig.model),
      text: res.text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costCents: debateCallCostCents(roleConfig, usage),
    };
    if (this.tokensUsedCount + usage.inputTokens + usage.outputTokens > this.tokenCeiling) {
      this.ceilingCrossedCentsCount += turn.costCents;
      this.transcript.push(turn);
      return null;
    }
    this.tokensUsedCount += usage.inputTokens + usage.outputTokens;
    this.totalCentsCount += turn.costCents;
    this.transcript.push(turn);
    return turn;
  }
}

/** One transcript line in the judge context — the engine's exact format. */
function transcriptLine(turn: DebateTurn): string {
  return `[${turn.role}${turn.independent ? " (independent)" : ` round ${turn.round}`}] ${turn.text}`;
}
