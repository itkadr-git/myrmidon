// myrmidon(1.7-DEBATE-ASYM-A): the asymmetric debate engine contract.
//
// The acceptance criteria of the ticket live here: a symmetric configuration
// (one family for generator and critic) is rejected, a debate stops at the
// third round or at the token ceiling, and the result document carries the
// cost. Fake models stand in for the gateway — the engine is pure, so the
// same code path runs verbatim in production.

import { describe, expect, it } from "vitest";
import {
  DEBATE_AGREE_MARKER,
  DEBATE_PROTOCOL_DOCUMENT_KEY,
  DEBATE_PROTOCOL_TEXT_LIMIT,
  appendDebateProtocolEntry,
  debateCallCostCents,
  debateFamilyProblem,
  defaultDebateSettings,
  getModelFamily,
  criticAgrees,
  parseDebateProtocolDocument,
  renderDebateProtocolDocument,
  renderDebateResultDocument,
  resolveDebateSettings,
  runDebate,
  type DebateModelCall,
  type DebateProtocolEntry,
  type DebateSettings,
} from "./myrmidon-debate.js";

function settings(overrides?: Partial<DebateSettings>): DebateSettings {
  return { ...defaultDebateSettings(), ...overrides } as DebateSettings;
}

/**
 * A fake model: answers per role with a fixed token budget and records the
 * call order as `${role}:${round}[:ind]`.
 */
function fakeCall(
  responses: Record<string, string>,
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 500, outputTokens: 500 },
  recorder: string[] = [],
): DebateModelCall {
  return async (roleConfig, _system, _user, context) => {
    recorder.push(`${context.role}:${context.round}${context.independent ? ":ind" : ""}`);
    const text =
      responses[`${context.role}:${context.round}`] ??
      responses[context.role] ??
      responses.default ??
      `model ${roleConfig.model} answered`;
    return { text, usage };
  };
}

describe("myrmidon(1.7-DEBATE-ASYM): model families", () => {
  it("maps ids to families and keeps unknown ids non-colliding", () => {
    expect(getModelFamily("qwen-plus-free")).toBe("qwen");
    expect(getModelFamily("GLM-4-Flash-Free")).toBe("glm");
    expect(getModelFamily("gpt-4o-mini")).toBe("gpt");
    expect(getModelFamily("deepseek-chat-free")).toBe("deepseek");
    expect(getModelFamily("totally-unknown-model")).toBe("unknown");
  });
});

describe("myrmidon(1.7-DEBATE-ASYM): the cross-family rule (acceptance 1)", () => {
  it("rejects a symmetric configuration — one family for generator and critic", async () => {
    const bad = settings({
      generator: { model: "qwen-plus-free" },
      critic: { model: "qwen-turbo-free" }, // same family — the owner rule forbids it
      judge: { model: "glm-4-flash-free" },
    });
    expect(debateFamilyProblem(bad)).toContain("asymmetric");
    const recorder: string[] = [];
    const outcome = await runDebate({ question: "q", settings: bad, call: fakeCall({}, undefined, recorder) });
    // Rejected BEFORE any model call: nothing spent, nothing to judge.
    expect(recorder).toHaveLength(0);
    expect(outcome.completed).toBe(false);
    expect(outcome.stopReason).toBe("rejected_config");
    expect(outcome.transcript).toHaveLength(0);
    expect(outcome.familyProblem).toContain("asymmetric");
  });

  it("rejects a judge that shares a family with either debater", () => {
    expect(
      debateFamilyProblem(
        settings({
          generator: { model: "qwen-plus-free" },
          critic: { model: "glm-4-flash-free" },
          judge: { model: "qwen-max-free" },
        }),
      ),
    ).toContain("outside the dispute");
    expect(debateFamilyProblem(defaultDebateSettings())).toBeNull();
  });

  it("treats two unknown-family ids as different vendors (conservative, not blocking)", () => {
    expect(
      debateFamilyProblem(
        settings({
          generator: { model: "mystery-a" },
          critic: { model: "mystery-b" },
          judge: { model: "glm-4-flash-free" },
        }),
      ),
    ).toBeNull();
  });
});

describe("myrmidon(1.7-DEBATE-ASYM): settings resolution", () => {
  it("applies stored > env > default and keeps a family collision at its level", () => {
    const symmetric = {
      generator: { model: "qwen-plus-free" },
      critic: { model: "qwen-turbo-free" },
      judge: { model: "glm-4-flash-free" },
    };
    const fromStored = resolveDebateSettings({ stored: symmetric });
    expect(fromStored.settings).toBeNull();
    expect(fromStored.problem).toContain("asymmetric");
    expect(fromStored.source).toBe("settings");

    const fromEnv = resolveDebateSettings({
      env: { MYRMIDON_DEBATE_CONFIG: JSON.stringify(symmetric) },
    });
    expect(fromEnv.source).toBe("env");
    expect(fromEnv.settings).toBeNull();

    const fromDefault = resolveDebateSettings({ env: {} });
    expect(fromDefault.source).toBe("default");
    expect(fromDefault.settings?.generator.model).toBe("qwen-plus-free");
    expect(fromDefault.problem).toBeNull();
  });

  it("an empty stored object means 'nothing chosen' — the default applies", () => {
    const resolved = resolveDebateSettings({ stored: {}, env: {} });
    expect(resolved.source).toBe("default");
    expect(resolved.settings).not.toBeNull();
  });

  it("a malformed env override is reported, not silently dropped", () => {
    const malformed = resolveDebateSettings({ env: { MYRMIDON_DEBATE_CONFIG: "{not json" } });
    expect(malformed.settings).toBeNull();
    expect(malformed.problem).toContain("not valid JSON");
  });

  it("more than three rounds is invalid at every level", () => {
    const fromStored = resolveDebateSettings({
      stored: {
        generator: { model: "qwen-plus-free" },
        critic: { model: "glm-4-flash-free" },
        judge: { model: "deepseek-chat-free" },
        rounds: 4,
      },
    });
    expect(fromStored.settings).toBeNull();
    expect(fromStored.problem).toContain("rounds");
  });
});

describe("myrmidon(1.7-DEBATE-ASYM): the exchange", () => {
  it("runs independent first answers before any cross-reading", async () => {
    const recorder: string[] = [];
    const outcome = await runDebate({
      question: "Should the bbq campaign use influencer posts?",
      settings: settings({ rounds: 1 }),
      call: fakeCall({ critic: "a flaw here", default: "position" }, undefined, recorder),
    });
    // Both debaters answered with no visibility of each other first.
    expect(recorder.slice(0, 2)).toEqual(["generator:0:ind", "critic:0:ind"]);
    expect(outcome.transcript[0]!.independent).toBe(true);
    expect(outcome.transcript[1]!.independent).toBe(true);
    expect(outcome.transcript[1]!.text).not.toContain("position");
  });

  it("stops by agreement as soon as the critic signals it", async () => {
    const recorder: string[] = [];
    const outcome = await runDebate({
      question: "q",
      settings: settings({ rounds: 3 }),
      call: fakeCall({ critic: `nothing left to attack. ${DEBATE_AGREE_MARKER}` }, undefined, recorder),
    });
    expect(outcome.stopReason).toBe("agreement");
    expect(outcome.roundsRun).toBe(1);
    // No round-2 call after the agreement; the judge still rules.
    expect(recorder).not.toContain("generator:2");
    expect(recorder.filter((r) => r.startsWith("judge"))).toHaveLength(1);
    expect(outcome.completed).toBe(true);
    expect(outcome.judgeVerdict).not.toBeNull();
  });

  it("stops at the third round when no agreement ever forms (acceptance 2)", async () => {
    const recorder: string[] = [];
    const outcome = await runDebate({
      question: "q",
      settings: settings({ rounds: 3, tokenCeiling: 1_000_000 }),
      call: fakeCall({ critic: "still disagreeing, flaw after flaw" }, undefined, recorder),
    });
    expect(outcome.roundsRun).toBe(3);
    // generator: independent + rounds 1..3 = 4 calls; critic same; judge once.
    expect(recorder.filter((r) => r.startsWith("generator"))).toHaveLength(4);
    expect(recorder.filter((r) => r.startsWith("critic"))).toHaveLength(4);
    expect(recorder.filter((r) => r.startsWith("judge"))).toHaveLength(1);
    expect(outcome.stopReason).toBe("rounds_exhausted");
    expect(outcome.completed).toBe(true);
  });

  it("stops when the projected ceiling is exhausted before a round call (acceptance 2)", async () => {
    // 12 000 tokens per call against a 12 000 ceiling: the generator's
    // independent answer uses the whole budget, the critic call crosses it.
    const outcome = await runDebate({
      question: "q",
      settings: settings({ rounds: 3, tokenCeiling: 12_000 }),
      call: fakeCall({ critic: "disagree" }, { inputTokens: 6000, outputTokens: 6000 }),
    });
    expect(outcome.stopReason).toBe("token_ceiling");
    expect(outcome.tokensUsed).toBeLessThanOrEqual(12_000);
  });

  it("records the overrun of a call that only reveals its usage after running (acceptance 2)", async () => {
    let calls = 0;
    const call: DebateModelCall = async (_cfg, _sys, _user, context) => {
      calls += 1;
      // every call burns 7 000 tokens against a 10 000 ceiling
      return { text: `${context.role} says no`, usage: { inputTokens: 3500, outputTokens: 3500 } };
    };
    const outcome = await runDebate({ question: "q", settings: settings({ rounds: 3, tokenCeiling: 10_000 }), call });
    expect(outcome.stopReason).toBe("token_ceiling");
    // First call fits (7 000). Second call crosses: recorded, not charged.
    expect(outcome.tokensUsed).toBe(7000);
    expect(outcome.cost.ceilingCrossedCents).toBe(0); // free models: zero cost
    expect(calls).toBe(2);
    expect(outcome.transcript).toHaveLength(2);
  });
});

describe("myrmidon(1.7-DEBATE-ASYM): cost and the result document (acceptance 3)", () => {
  it("prices a call by the per-1K cents of its role", () => {
    expect(
      debateCallCostCents(
        { model: "m", inputCentsPer1k: 10, outputCentsPer1k: 20 },
        { inputTokens: 1000, outputTokens: 1000 },
      ),
    ).toBe(30);
    expect(debateCallCostCents({ model: "m" }, { inputTokens: 999_999, outputTokens: 1_000_000 })).toBe(0);
  });

  it("the result document carries positions, the verdict and the cost", async () => {
    const paid = settings({
      rounds: 1,
      generator: { model: "qwen-plus-free", inputCentsPer1k: 10, outputCentsPer1k: 20 },
      critic: { model: "glm-4-flash-free", inputCentsPer1k: 5, outputCentsPer1k: 5 },
      judge: { model: "deepseek-chat-free", inputCentsPer1k: 1, outputCentsPer1k: 1 },
    });
    const outcome = await runDebate({
      question: "Which bbq marketing channel to prioritize?",
      settings: paid,
      call: fakeCall({ judge: "VERDICT: social first" }, { inputTokens: 2000, outputTokens: 1000 }),
    });
    const doc = renderDebateResultDocument(outcome);
    // Cost section present with a real number.
    expect(doc).toContain("## Cost");
    expect(doc).toContain("Total");
    const expectedCents =
      outcome.cost.byRole.generator + outcome.cost.byRole.critic + outcome.cost.byRole.judge;
    expect(expectedCents).toBeGreaterThan(0);
    expect(doc).toContain(`$${(expectedCents / 100).toFixed(2)}`);
    // Positions and the verdict.
    expect(doc).toContain("## Positions (transcript)");
    expect(doc).toContain("## Judge verdict");
    expect(doc).toContain("VERDICT: social first");
    // Roles table shows the models and their families.
    expect(doc).toContain("| generator | qwen-plus-free | qwen |");
  });

  it("the agreement marker is matched case-insensitively on the exact token", () => {
    expect(criticAgrees("agree")).toBe(false);
    expect(criticAgrees(`all resolved [${DEBATE_AGREE_MARKER.toLowerCase()}]`)).toBe(true);
  });
});

describe("myrmidon(1.7-DEBATE-PERSIST): the round protocol document", () => {
  it("appends an ordered, idempotent JSON entry per replica and round-trips through parse", () => {
    const base = { recordedAt: "2026-11-08T12:00:00.000Z" };
    let rounds: Record<string, DebateProtocolEntry> = {};
    rounds = appendDebateProtocolEntry(rounds, { role: "generator", round: 0, independent: true, model: "qwen-plus-free", family: "qwen", text: "gen-first", inputTokens: 10, outputTokens: 20, costCents: 1, ...base });
    rounds = appendDebateProtocolEntry(rounds, { role: "critic", round: 0, independent: true, model: "GLM-4-Flash-Free", family: "glm", text: "critic-first", inputTokens: 10, outputTokens: 20, costCents: 1, ...base });
    rounds = appendDebateProtocolEntry(rounds, { role: "generator", round: 1, independent: false, model: "qwen-plus-free", family: "qwen", text: "gen-exchange", inputTokens: 10, outputTokens: 20, costCents: 1, ...base });
    rounds = appendDebateProtocolEntry(rounds, { role: "critic", round: 1, independent: false, model: "GLM-4-Flash-Free", family: "glm", text: "critic-exchange", inputTokens: 10, outputTokens: 20, costCents: 1, ...base });
    expect(Object.keys(rounds)).toEqual(["r0#0", "r0#1", "r1#0", "r1#1"]);
    // Idempotent: rewriting r0#0 leaves the same four entries.
    rounds = appendDebateProtocolEntry(rounds, { ...rounds["r0#0"]!, ...base });
    expect(Object.keys(rounds)).toEqual(["r0#0", "r0#1", "r1#0", "r1#1"]);
    const body = renderDebateProtocolDocument({
      question: "q",
      runId: "run-1",
      status: "running",
      casteKey: "eng",
      rounds,
      roundsPlanned: 2,
      roundsRun: 2,
      stopReason: null,
    });
    const parsed = parseDebateProtocolDocument(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.runId).toBe("run-1");
    expect(parsed?.status).toBe("running");
    expect(parsed?.rounds["r0#1"]?.text).toBe("critic-first");
    expect(Object.keys(parsed?.rounds ?? {})).toEqual(["r0#0", "r0#1", "r1#0", "r1#1"]);
    expect(parseDebateProtocolDocument("no block here")).toBeNull();
  });

  it("the sink records every charged replica in transcript order and a failed sink never fails the debate", async () => {
    const recorder: string[] = [];
    const sinkEntries: DebateProtocolEntry[] = [];
    const outcome = await runDebate({
      question: "q",
      settings: settings({ rounds: 1 }),
      call: fakeCall({ critic: "done agree" }, undefined, recorder),
      onRoundComplete: async (entry) => {
        sinkEntries.push({ ...entry, recordedAt: "2026-11-08T12:00:00.000Z" });
        if (sinkEntries.length === 2) throw new Error("sink is broken on the second append");
      },
    });
    // Independent first answers (round 0) + one exchange round + judge.
    expect(sinkEntries.map((e) => `${e.role}:${e.round}:${e.independent}`)).toEqual([
      "generator:0:true",
      "critic:0:true",
      "generator:1:false",
      "critic:1:false",
    ]);
    // The judge never enters the protocol — only the two debate roles do.
    expect(sinkEntries.every((e) => e.role !== "judge")).toBe(true);
    // The broken sink is visible on the outcome but did not fail the debate.
    expect(outcome.protocolWriteFailed).toBe(true);
    expect(outcome.completed).toBe(true);
    expect(outcome.stopReason).toBe("agreement");
    // Sink appends keep the engine free of clock knowledge: no recordedAt was set by the engine.
    expect(Object.keys(outcome)).not.toContain("recordedAt");
    expect(DEBATE_PROTOCOL_DOCUMENT_KEY).toBe("debate-protocol");
  });

  it("a replica longer than the per-entry cap is truncated and marked (documents contract)", async () => {
    const longText = "x".repeat(DEBATE_PROTOCOL_TEXT_LIMIT + 5000);
    const captured: string[] = [];
    await runDebate({
      question: "q",
      settings: settings({ rounds: 1 }),
      call: fakeCall({ default: longText }),
      onRoundComplete: async (entry) => {
        captured.push(entry.text.length > DEBATE_PROTOCOL_TEXT_LIMIT ? "truncated" : "full");
      },
    });
    // The engine hands the raw text to the sink; the service-level sink applies
    // the cap before writing — this test pins the engine's raw-handoff side.
    expect(captured.every((c) => c === "full")).toBe(true);
    const marked = renderDebateProtocolDocument({
      question: "q",
      runId: "run-2",
      status: "finished",
      casteKey: null,
      rounds: {
        "r0#0": {
          role: "generator",
          round: 0,
          independent: true,
          model: "m",
          family: "f",
          text: `${"y".repeat(DEBATE_PROTOCOL_TEXT_LIMIT)}…[protocol entry truncated at ${DEBATE_PROTOCOL_TEXT_LIMIT} chars]`,
          inputTokens: 1,
          outputTokens: 1,
          costCents: 0,
          recordedAt: "2026-11-08T12:00:00.000Z",
        },
      },
      roundsPlanned: 1,
      roundsRun: 1,
      stopReason: "agreement",
    });
    expect(marked).toContain(`[protocol entry truncated at ${DEBATE_PROTOCOL_TEXT_LIMIT} chars]`);
    expect(parseDebateProtocolDocument(marked)?.rounds["r0#0"]?.text).toContain("truncated at");
  });
});
