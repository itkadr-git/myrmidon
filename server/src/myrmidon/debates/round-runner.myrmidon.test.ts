// myrmidon(1.7 DEBATE-ASYM §3.3, OPE-12077): the debate round service over
// mock models — no database, no gateway, no LLM. The ticket's acceptance
// rules are proven here:
//   1. round 1 collects the parallel (independent) replies of A and B —
//      both are asked the bare question and neither sees the other;
//   2. a token-ceiling overrun interrupts the round (recorded, not charged,
//      no further rounds accepted);
//   3. after round 3 the FULL context goes to the judge verbatim — every
//      collected reply, in order, byte-for-byte in the judge prompt.
// Also covered: strict round ordering, the [AGREE] stop signal, and the
// engine-shaped judge accounting when the judge call itself crosses.

import { describe, expect, it } from "vitest";
import {
  composeRoleSystemPrompt,
  DEBATE_AGREE_MARKER,
  defaultDebateSettings,
  type DebateModelCall,
  type DebateRole,
  type DebateSettings,
  type DebateUsage,
} from "@myrmidon/shared";
import {
  DEBATE_PARTICIPANT_A,
  DEBATE_PARTICIPANT_B,
  DebateRoundError,
  DebateRoundRunner,
} from "./round-runner.js";

const QUESTION = "Which bbq channel should we prioritize next quarter?";

interface ScriptedReply {
  text: string;
  usage: DebateUsage;
}

type Script = Partial<Record<DebateRole, ScriptedReply>>;

/** Default mock: short free replies, a critic that never agrees. */
function reply(text: string, inputTokens = 100, outputTokens = 50): ScriptedReply {
  return { text, usage: { inputTokens, outputTokens } };
}

function scriptedCall(script: Script, recorder: string[] = []): DebateModelCall {
  return async (roleConfig, system, userPrompt, context) => {
    recorder.push(`${context.round}:${context.role}`);
    expect(system).toBe(composeRoleSystemPrompt(context.role, null));
    const picked = script[context.role];
    if (!picked) throw new Error(`unexpected call of role ${context.role}`);
    void roleConfig;
    void userPrompt;
    return { text: picked.text, usage: picked.usage };
  };
}

function runner(input: {
  question?: string;
  settings?: Partial<DebateSettings>;
  call: DebateModelCall;
}): DebateRoundRunner {
  const base = defaultDebateSettings();
  return new DebateRoundRunner({
    question: input.question ?? QUESTION,
    settings: { ...base, ...input.settings },
    call: input.call,
  });
}

const FULL_SCRIPT: Script = {
  generator: reply("A1: prioritize the local-market partnerships channel."),
  critic: reply(`B1: the cost estimate is missing. ${DEBATE_AGREE_MARKER}`),
};

describe("myrmidon(1.7 DEBATE-ASYM §3.3): the debate round service", () => {
  it("round 1 collects the parallel first answers: both reply to the bare question, neither sees the other", async () => {
    const prompts: string[] = [];
    const call: DebateModelCall = async (_config, _system, userPrompt, context) => {
      prompts.push(`${context.role}<<<${userPrompt}`);
      expect(context.independent).toBe(true);
      expect(context.round).toBe(1);
      return context.role === DEBATE_PARTICIPANT_A
        ? { text: "answer A", usage: { inputTokens: 100, outputTokens: 50 } }
        : { text: "answer B", usage: { inputTokens: 100, outputTokens: 50 } };
    };
    const h = runner({ call });

    const record = await h.collectRound(1);

    // Both participants collected, A first, each with its own turn.
    expect(record.turns.map((t) => t.role)).toEqual([DEBATE_PARTICIPANT_A, DEBATE_PARTICIPANT_B]);
    expect(record.interrupted).toBe(false);
    expect(record.stopDetail).toBeNull();
    expect(h.roundsCollected).toBe(1);
    // The two replies are independent: identical bare question, no peer text.
    expect(prompts).toHaveLength(2);
    const [aPrompt, bPrompt] = prompts;
    expect(aPrompt).toBe(`${DEBATE_PARTICIPANT_A}<<<Question: ${QUESTION}`);
    expect(bPrompt).toBe(`${DEBATE_PARTICIPANT_B}<<<Question: ${QUESTION}`);
    expect(aPrompt).not.toContain("answer B");
    expect(bPrompt).not.toContain("answer A");
    // Tokens and cents charged exactly once per reply.
    expect(h.tokensUsed).toBe(300);
    expect(h.totalCents).toBe(0);
  });

  it("an exchange round shows each side the other's latest reply before attacking it", async () => {
    const prompts: string[] = [];
    const call: DebateModelCall = async (_config, _system, userPrompt, context) => {
      prompts.push(`${context.round}:${context.role}<<<${userPrompt}`);
      return {
        text: context.role === DEBATE_PARTICIPANT_A ? "revised A2" : "attack B2",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    };
    const h = runner({ call });
    await h.collectRound(1);

    const record = await h.collectRound(2);

    expect(record.turns.map((t) => t.role)).toEqual([DEBATE_PARTICIPANT_A, DEBATE_PARTICIPANT_B]);
    expect(prompts).toHaveLength(4);
    // A (generator) revises against B's round-1 reply, B (critic) attacks A's revised text.
    expect(prompts[2]).toContain(`The critic's position:\nanswer B`);
    expect(prompts[3]).toContain(`The generator's current answer:\nrevised A2`);
    expect(prompts[2]).toContain(`Question: ${QUESTION}`);
  });

  it("exceeding the token ceiling interrupts the round: recorded, not charged, and the next round is refused", async () => {
    const calls: string[] = [];
    const call = scriptedCall(
      { generator: reply("A1", 100, 50), critic: reply("B1 overruns", 40_000, 10_000) },
      calls,
    );
    const h = runner({ settings: { rounds: 3, tokenCeiling: 1000 }, call });

    const record = await h.collectRound(1);

    // The crossing reply ran and is kept in the transcript verbatim, but its
    // 50 000 tokens are NOT charged and it is not a completed round reply.
    expect(record.interrupted).toBe(true);
    expect(record.stopDetail).toContain("ceiling");
    expect(record.turns.map((t) => t.role)).toEqual([DEBATE_PARTICIPANT_A]);
    expect(h.tokensUsed).toBe(150);
    expect(h.ceilingCrossedCents).toBe(0);
    expect(h.turns).toHaveLength(2);
    expect(h.turns[1]!.text).toBe("B1 overruns");
    // Round 1's answers are still in, so the judge may still take the transcript.
    expect(h.judgeReady).toBe(true);
    // No next round after an interrupt.
    await expect(h.collectRound(2)).rejects.toMatchObject({ code: "round_interrupted" });
  });

  it("a projected exchange call that would cross the ceiling is refused before being made", async () => {
    const calls: string[] = [];
    const call = scriptedCall({ generator: reply("A1", 800, 200), critic: reply("B1", 800, 200) }, calls);
    const h = runner({ settings: { rounds: 3, tokenCeiling: 5000 }, call });
    await h.collectRound(1);
    const before = h.turns.length;

    const record = await h.collectRound(2);

    // 2000 used + 4000 projected > 5000: A's call never happens.
    expect(calls).toEqual(["1:generator", "1:critic"]);
    expect(record.turns).toHaveLength(0);
    expect(record.interrupted).toBe(true);
    expect(record.stopDetail).toContain("500 remain");
    expect(h.turns).toHaveLength(before);
    expect(h.roundsCollected).toBe(1);
  });

  it("after round 3 the full context is handed to the judge without distortion", async () => {
    const texts: Partial<Record<DebateRole, string>> = {
      generator: "A independent first",
      critic: `B independent first, then flaws. ${DEBATE_AGREE_MARKER}`,
    };
    const call: DebateModelCall = async (_config, _system, userPrompt, context) => {
      if (context.role === "judge") {
        // Every collected reply is in the judge prompt verbatim and in order.
        expect(userPrompt).toContain(`Question: ${QUESTION}`);
        expect(userPrompt).toContain(`[generator (independent)] ${texts.generator}`);
        expect(userPrompt).toContain(`[critic (independent)] ${texts.critic}`);
        expect(userPrompt.endsWith("Deliver your verdict and answer.")).toBe(true);
        return { text: "VERDICT: prioritize local partnerships.", usage: { inputTokens: 500, outputTokens: 200 } };
      }
      return { text: texts[context.role]!, usage: { inputTokens: 100, outputTokens: 50 } };
    };
    const h = runner({ settings: { rounds: 3 }, call });
    for (let round = 1; round <= 3; round += 1) {
      const record = await h.collectRound(round);
      if (round === 1) {
        // Round 1's critic carries the marker: the caller may skip to the judge.
        expect(record.criticAgreed).toBe(true);
      }
    }
    expect(h.roundsCollected).toBe(3);

    const context = h.buildJudgeContext();
    expect(context.question).toBe(QUESTION);
    expect(context.turns).toHaveLength(6); // 2 first answers + 4 exchange replies
    expect(context.transcriptText).toBe(
      [
        `[generator (independent)] ${texts.generator}`,
        `[critic (independent)] ${texts.critic}`,
        "[generator round 2] A independent first",
        "[critic round 2] B independent first, then flaws. [AGREE]",
        "[generator round 3] A independent first",
        "[critic round 3] B independent first, then flaws. [AGREE]",
      ].join("\n\n"),
    );

    const judgeTurn = await h.runJudge();
    expect(judgeTurn?.role).toBe("judge");
    expect(h.judgeVerdict).toBe("VERDICT: prioritize local partnerships.");
    // 6 exchange/first replies x 150 + judge 700 = 1600 tokens charged.
    expect(h.tokensUsed).toBe(1600);
    // The judge cannot be called twice.
    await expect(h.runJudge()).rejects.toMatchObject({ code: "judge_called" });
  });

  it("refuses a round out of order or past the planned maximum", async () => {
    const h = runner({ settings: { rounds: 2 }, call: scriptedCall(FULL_SCRIPT) });
    await expect(h.collectRound(0)).rejects.toMatchObject({ code: "round_order" });
    await expect(h.collectRound(2)).rejects.toMatchObject({ code: "round_order" });
    await h.collectRound(1);
    await h.collectRound(2);
    await expect(h.collectRound(3)).rejects.toMatchObject({ code: "round_order" });
  });

  it("keeps the judge's turn when an exchange round was cut short by the ceiling", async () => {
    const call = scriptedCall({
      generator: reply("A1", 2000, 1000),
      critic: reply("B1", 2000, 1000),
      judge: reply("VERDICT: partial transcript.", 300, 100),
    });
    const h = runner({ settings: { rounds: 3, tokenCeiling: 10_000 }, call });
    await h.collectRound(1);
    // Round 2: 6000 used + 4000 projected > 10 000 is equality (10_000 > 10_000 is false),
    // but the generator turn of 3000 takes tokensUsed to 9000, then the critic pre-check:
    // 9000 + 4000 = 13000 > 10_000, which interrupts the round before critic runs.
    const record = await h.collectRound(2);
    expect(record.interrupted).toBe(true);
    expect(h.judgeReady).toBe(true);

    const prompt = h.buildJudgePrompt();
    expect(prompt).toContain("[generator (independent)] A1");
    expect(prompt).toContain("[critic (independent)] B1");
    const judgeTurn = await h.runJudge();
    expect(judgeTurn).not.toBeNull();
    expect(h.judgeVerdict).toBe("VERDICT: partial transcript.");
    // 6000 (round 1) + 3000 (round 2 generator) + 400 (judge) = 9400 tokens charged.
    expect(h.tokensUsed).toBe(6000 + 3000 + 400);
  });

  it("a judge call that crosses the ceiling is recorded uncharged and yields no verdict", async () => {
    const call = scriptedCall({
      generator: reply("A1", 800, 200),
      critic: reply("B1", 800, 200),
      judge: reply("too long", 100_000, 50_000),
    });
    const h = runner({ settings: { rounds: 1, tokenCeiling: 2000 }, call });
    await h.collectRound(1);
    const judgeTurn = await h.runJudge();
    expect(judgeTurn).toBeNull();
    expect(h.judgeVerdict).toBeNull();
    expect(h.tokensUsed).toBe(2000);
    expect(h.ceilingCrossedCents).toBe(0);
    expect(h.interrupted).toBe(true);
  });

  it("rejects an empty question", () => {
    expect(() => runner({ question: "   ", call: scriptedCall(FULL_SCRIPT) })).toThrow(DebateRoundError);
  });

  it("free replies still count tokens against the ceiling; priced replies add cents", async () => {
    const priced: DebateSettings = {
      generator: { model: "qwen-plus", inputCentsPer1k: 2, outputCentsPer1k: 6 },
      critic: { model: "glm-4-flash-free" },
      judge: { model: "deepseek-chat-free" },
      rounds: 1,
      tokenCeiling: 50_000,
    };
    const h = new DebateRoundRunner({ question: QUESTION, settings: priced, call: scriptedCall(FULL_SCRIPT) });
    await h.collectRound(1);
    // generator: 100/1k*2 + 50/1k*6 = 0.2 + 0.3 → rounds to 1 cent (the engine's per-call math).
    // critic and judge are free (0) but their tokens still count.
    expect(h.totalCents).toBe(1);
    expect(h.tokensUsed).toBe(300);
  });
});
