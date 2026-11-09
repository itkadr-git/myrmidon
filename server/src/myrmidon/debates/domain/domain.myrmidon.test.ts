// server/src/myrmidon/debates/domain/domain.myrmidon.test.ts
//
// myrmidon(1.7 DEBATE-ASYM, OPE-12076): unit tests for the debate domain —
// pure data, no database, no gateway, no LLM. The ticket's acceptance rules
// are proven here:
//   1. a valid DebateRun with two polar participants and a judge;
//   2. the max_rounds=3 limit is enforced;
//   3. the judge never participates in the pro/contra rounds;
// plus the full state lifecycle draft → in_progress → judge_verdict → done,
// the token ceiling, and the schema validation of a persisted run.

import { describe, expect, it } from "vitest";
import {
  createDebateRun,
  collectRound,
  completeDebateRun,
  concludeForJudge,
  DebateRunError,
  DEBATE_RUN_DEFAULT_MAX_ROUNDS,
  DEBATE_RUN_MAX_ROUNDS,
  normalizeMaxRounds,
  recordVerdict,
  remainingTokens,
  startDebateRun,
} from "./state-machine.js";
import {
  parseDebateParticipantRole,
  parseDebateRunState,
  validateDebateParticipants,
  validateDebateRun,
} from "./schema.js";
import type { DebateParticipant, DebateRun } from "./types.js";

const PRO: DebateParticipant = { id: "p-pro", role: "pro", model: "env:DEBATE_PRO_MODEL" };
const CONTRA: DebateParticipant = { id: "p-contra", role: "contra", model: "env:DEBATE_CONTRA_MODEL" };
const JUDGE: DebateParticipant = { id: "p-judge", role: "judge", model: "env:DEBATE_JUDGE_MODEL" };

function draftRun(overrides: Partial<Parameters<typeof createDebateRun>[0]> = {}): DebateRun {
  return createDebateRun({
    id: "run-1",
    config: { question: "Should we ship the feature behind a flag?", maxRounds: 3, tokenCeiling: null },
    participants: [PRO, CONTRA, JUDGE],
    prompts: {
      pro: "Defend the proposal.",
      contra: "Attack the proposal.",
    },
    ...overrides,
  });
}

function runningRun(): DebateRun {
  return startDebateRun(draftRun());
}

describe("debate domain (OPE-12076)", () => {
  describe("createDebateRun", () => {
    it("creates a valid draft run with two polar participants and a judge", () => {
      const run = draftRun();
      expect(run.state).toBe("draft");
      expect(run.proParticipantId).toBe(PRO.id);
      expect(run.contraParticipantId).toBe(CONTRA.id);
      expect(run.judgeParticipantId).toBe(JUDGE.id);
      expect(run.participants[PRO.id]?.role).toBe("pro");
      expect(run.participants[CONTRA.id]?.role).toBe("contra");
      expect(run.participants[JUDGE.id]?.role).toBe("judge");
      expect(run.maxRounds).toBe(3);
      expect(run.roundCount).toBe(0);
      expect(run.rounds).toEqual([]);
      expect(run.verdict).toBeNull();
    });

    it("refuses a run without all three roles", () => {
      expect(() =>
        createDebateRun({
          id: "run-2",
          config: { question: "q", maxRounds: 3, tokenCeiling: null },
          participants: [PRO, CONTRA],
          prompts: { pro: "p", contra: "c" },
        }),
      ).toThrowError(DebateRunError);
    });

    it("refuses a run where the judge shares a participant with a pole", () => {
      expect(() =>
        draftRun({
          participants: [PRO, CONTRA, { ...JUDGE, id: PRO.id }],
        }),
      ).toThrowError(/distinct participants/);
    });

    it("caps maxRounds at the domain limit of 3", () => {
      expect(normalizeMaxRounds(3)).toBe(3);
      expect(normalizeMaxRounds(7)).toBe(DEBATE_RUN_MAX_ROUNDS);
      expect(DEBATE_RUN_DEFAULT_MAX_ROUNDS).toBe(3);
      const run = draftRun({ config: { question: "q", maxRounds: 7, tokenCeiling: null } });
      expect(run.maxRounds).toBe(3);
      expect(() => normalizeMaxRounds(0)).toThrowError(DebateRunError);
    });
  });

  describe("lifecycle draft → in_progress → judge_verdict → done", () => {
    it("walks the full happy path", () => {
      let run = runningRun();
      expect(run.state).toBe("in_progress");
      run = collectRound(
        run,
        {
          pro: { participantId: PRO.id, text: "Ship it behind a flag." },
          contra: { participantId: CONTRA.id, text: "The flag adds a code path." },
        },
        { pro: 100, contra: 120 },
      );
      run = collectRound(
        run,
        {
          pro: { participantId: PRO.id, text: "The path is tested." },
          contra: { participantId: CONTRA.id, text: "Tests rot." },
        },
        { pro: 90, contra: 110 },
      );
      run = collectRound(
        run,
        {
          pro: { participantId: PRO.id, text: "We remove the flag next release." },
          contra: { participantId: CONTRA.id, text: "Never happens in practice." },
        },
        { pro: 80, contra: 100 },
      );
      expect(run.roundCount).toBe(3);
      expect(run.rounds.map((r) => r.index)).toEqual([0, 1, 2]);
      expect(run.tokensUsed).toBe(600);

      const conclusion = concludeForJudge(run);
      expect(conclusion.judgeParticipant.id).toBe(JUDGE.id);
      expect(conclusion.transcript).toHaveLength(6);
      expect(conclusion.transcript.every((s) => s.participantId !== JUDGE.id)).toBe(true);

      run = recordVerdict(run, "Ship behind the flag, with a removal date.", 150);
      expect(run.state).toBe("judge_verdict");
      expect(run.verdict?.participantId).toBe(JUDGE.id);
      expect(run.tokensUsed).toBe(750);

      run = completeDebateRun(run);
      expect(run.state).toBe("done");
      expect(run.verdict?.text).toBe("Ship behind the flag, with a removal date.");
    });

    it("refuses starting twice and completing before the verdict", () => {
      const run = runningRun();
      expect(() => startDebateRun(run)).toThrowError(/starts from draft/);
      expect(() => completeDebateRun(run)).toThrowError(/completes from judge_verdict/);
    });
  });

  describe("max_rounds=3 enforced", () => {
    it("refuses a fourth round", () => {
      let run = runningRun();
      for (let round = 0; round < 3; round += 1) {
        run = collectRound(
          run,
          {
            pro: { participantId: PRO.id, text: `pro ${round}` },
            contra: { participantId: CONTRA.id, text: `contra ${round}` },
          },
          { pro: 10, contra: 10 },
        );
      }
      expect(run.roundCount).toBe(3);
      expect(() =>
        collectRound(
          run,
          {
            pro: { participantId: PRO.id, text: "pro 4" },
            contra: { participantId: CONTRA.id, text: "contra 4" },
          },
          { pro: 10, contra: 10 },
        ),
      ).toThrowError(DebateRunError);
      try {
        collectRound(
          run,
          {
            pro: { participantId: PRO.id, text: "pro 4" },
            contra: { participantId: CONTRA.id, text: "contra 4" },
          },
          { pro: 10, contra: 10 },
        );
      } catch (error) {
        expect((error as DebateRunError).code).toBe("rounds_exhausted");
      }
    });

    it("refuses the judge conclusion before all rounds are collected", () => {
      const run = collectRound(
        runningRun(),
        {
          pro: { participantId: PRO.id, text: "pro" },
          contra: { participantId: CONTRA.id, text: "contra" },
        },
        { pro: 5, contra: 5 },
      );
      expect(() => concludeForJudge(run)).toThrowError(/all 3 rounds/);
      expect(() => recordVerdict(run, "too early", 10)).toThrowError(DebateRunError);
    });
  });

  describe("the judge is outside the dispute", () => {
    it("refuses a judge statement in a round", () => {
      const run = runningRun();
      expect(() =>
        collectRound(
          run,
          {
            pro: { participantId: JUDGE.id, text: "I rule..." },
            contra: { participantId: CONTRA.id, text: "contra" },
          },
          { pro: 5, contra: 5 },
        ),
      ).toThrowError(/outside the dispute/);
      expect(() =>
        collectRound(
          run,
          {
            pro: { participantId: PRO.id, text: "pro" },
            contra: { participantId: JUDGE.id, text: "I rule..." },
          },
          { pro: 5, contra: 5 },
        ),
      ).toThrowError(/outside the dispute/);
    });

    it("never lets a judge statement into the collected transcript", () => {
      let run = runningRun();
      for (let round = 0; round < 3; round += 1) {
        run = collectRound(
          run,
          {
            pro: { participantId: PRO.id, text: `pro ${round}` },
            contra: { participantId: CONTRA.id, text: `contra ${round}` },
          },
          { pro: 5, contra: 5 },
        );
      }
      const { transcript } = concludeForJudge(run);
      expect(transcript.every((s) => s.participantId === PRO.id || s.participantId === CONTRA.id)).toBe(true);
    });
  });

  describe("token ceiling", () => {
    it("tracks the remaining budget and refuses a round past the ceiling", () => {
      const run = draftRun({ config: { question: "q", maxRounds: 3, tokenCeiling: 100 } });
      const started = startDebateRun(run);
      expect(remainingTokens(started)).toBe(100);
      const afterOne = collectRound(
        started,
        {
          pro: { participantId: PRO.id, text: "pro" },
          contra: { participantId: CONTRA.id, text: "contra" },
        },
        { pro: 40, contra: 50 },
      );
      expect(afterOne.tokensUsed).toBe(90);
      expect(remainingTokens(afterOne)).toBe(10);
      expect(() =>
        collectRound(
          afterOne,
          {
            pro: { participantId: PRO.id, text: "pro" },
            contra: { participantId: CONTRA.id, text: "contra" },
          },
          { pro: 10, contra: 10 },
        ),
      ).toThrowError(/past the ceiling/);
    });
  });
});

describe("debate schema (OPE-12076)", () => {
  it("validates roles and states", () => {
    expect(parseDebateParticipantRole("pro")).toEqual({ role: "pro", problem: null });
    expect(parseDebateParticipantRole("moderator")?.problem).toBeTruthy();
    expect(parseDebateRunState("judge_verdict")).toEqual({ state: "judge_verdict", problem: null });
    expect(parseDebateRunState("archived")?.problem).toBeTruthy();
  });

  it("requires exactly one pro, one contra, and one judge", () => {
    const ok = validateDebateParticipants([PRO, CONTRA, JUDGE]);
    expect(ok.problem).toBeNull();
    expect(ok.participants).toHaveLength(3);
    const twoJudges = validateDebateParticipants([PRO, CONTRA, JUDGE, { ...JUDGE, id: "p-judge-2" }]);
    expect(twoJudges.participants).toBeNull();
    expect(twoJudges.problem).toMatch(/exactly one pro/);
    const duplicate = validateDebateParticipants([PRO, CONTRA, { ...JUDGE, id: CONTRA.id }]);
    expect(duplicate.participants).toBeNull();
  });

  it("accepts a valid persisted run and rejects a corrupted one", () => {
    let run = startDebateRun(draftRun());
    run = collectRound(
      run,
      {
        pro: { participantId: PRO.id, text: "pro" },
        contra: { participantId: CONTRA.id, text: "contra" },
      },
      { pro: 5, contra: 5 },
    );
    const ok = validateDebateRun(run);
    expect(ok.problem).toBeNull();
    expect(ok.run?.id).toBe("run-1");

    const judgeInRound = validateDebateRun({
      ...run,
      rounds: [
        {
          index: 0,
          pro: { participantId: JUDGE.id, round: 0, text: "I rule" },
          contra: { participantId: CONTRA.id, round: 0, text: "contra" },
        },
      ],
    });
    expect(judgeInRound.run).toBeNull();
    expect(judgeInRound.problem).toMatch(/only pro and contra/);

    const brokenCount = validateDebateRun({ ...run, roundCount: 5 });
    expect(brokenCount.run).toBeNull();
    expect(brokenCount.problem).toMatch(/exceed maxRounds/);

    const draftWithRounds = validateDebateRun({ ...run, state: "draft" });
    expect(draftWithRounds.run).toBeNull();

    const verdictTooEarly = validateDebateRun({
      ...run,
      verdict: { participantId: JUDGE.id, text: "v" },
    });
    expect(verdictTooEarly.run).toBeNull();

    const wrongRoles = validateDebateRun({
      ...run,
      judgeParticipantId: CONTRA.id,
    });
    expect(wrongRoles.run).toBeNull();
    expect(wrongRoles.problem).toMatch(/participants disagree/);
  });
});
