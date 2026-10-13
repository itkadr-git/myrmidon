// server/src/myrmidon/prompt-budget/prompt-budget.myrmidon.test.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET B): the acceptance tests of the prompt-budget
// thresholds.
//
// The *.myrmidon.test.ts style of this repo: no database, neutral data, the
// decisions pinned at the domain seams (the shared resolver and the module
// functions with fake ports). The decisions the ticket names:
//
//   1. the threshold counts against the model's window, not a constant;
//   2. a settings change (as a PUT stores it) is visible to the next
//      evaluation — no restart, no cache;
//   3. the attention card exists exactly while the last run is over a
//      threshold, re-grades warn ↔ crit and disappears back under warn;
//   4. a run without a breakdown (a non-gateway run) still signals on its
//      total, with an empty parts list in the detail;
//   5. an unknown model window falls back to the settings'
//      fallbackWindowTokens;
//   6. a disabled feature reports the numbers but never signals;
//   7. the signal dedup: one comment per agent per window (the metadata key
//      carries the window), a second pass in the same window writes nothing.

import { describe, expect, it } from "vitest";
import {
  ATTENTION_SOURCE_KINDS,
  buildPromptBudgetRunStatus,
  defaultPromptBudgetSettings,
  normalizePromptBudgetSettings,
  promptBudgetLevel,
  promptBudgetPct,
  promptBudgetSettingsSchema,
  promptBudgetSignalKey,
  topPromptBudgetParts,
  type PromptBudgetAgentStatus,
  type PromptBudgetSettings,
} from "@paperclipai/shared";
import { buildPromptBudgetAttentionCards } from "./attention.js";
import { deliverPromptBudgetSignal, type PromptBudgetSignalPorts } from "./signal.js";
import { parsePromptBreakdown } from "../prompt-budget-advice/source.js";

const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const OPTIMIZER = "33333333-3333-4333-8333-333333333333";

function settings(overrides: Partial<PromptBudgetSettings> = {}): PromptBudgetSettings {
  return { ...defaultPromptBudgetSettings(), ...overrides };
}

function agentStatus(overrides: Partial<PromptBudgetAgentStatus> = {}): PromptBudgetAgentStatus {
  const s = settings();
  return {
    agentId: AGENT_A,
    model: "neutral-model",
    windowTokens: 1000,
    windowIsFallback: false,
    lastRun: buildPromptBudgetRunStatus({
      runId: "run-1",
      total: 950,
      parts: {},
      windowTokens: 1000,
      settings: s,
    }),
    settings: s,
    ...overrides,
  };
}

describe("myrmidon(1.6.3 PROMPT-BUDGET B) settings contract", () => {
  it("normalizes an absent row to the documented defaults", () => {
    expect(normalizePromptBudgetSettings(undefined)).toEqual({
      warnPct: 70,
      critPct: 90,
      enabled: true,
      fallbackWindowTokens: 200_000,
      optimizerAgentId: null,
    });
  });

  it("keeps the additive fields of the sibling parts (optimizerAgentId)", () => {
    const stored = { ...settings(), optimizerAgentId: OPTIMIZER };
    expect(normalizePromptBudgetSettings(stored).optimizerAgentId).toBe(OPTIMIZER);
  });

  it("rejects crit <= warn and out-of-range values", () => {
    expect(
      promptBudgetSettingsSchema.safeParse({ ...settings(), warnPct: 90, critPct: 90 }).success,
    ).toBe(false);
    expect(
      promptBudgetSettingsSchema.safeParse({ ...settings(), warnPct: 0 }).success,
    ).toBe(false);
    expect(
      promptBudgetSettingsSchema.safeParse({ ...settings(), fallbackWindowTokens: 10 }).success,
    ).toBe(false);
    expect(
      promptBudgetSettingsSchema.safeParse({ ...settings(), optimizerAgentId: "not-a-uuid" })
        .success,
    ).toBe(false);
  });

  it("an unreadable row normalizes to defaults, never half-applies", () => {
    expect(normalizePromptBudgetSettings({ warnPct: "high" })).toEqual(defaultPromptBudgetSettings());
  });
});

describe("myrmidon(1.6.3 PROMPT-BUDGET B) level resolution", () => {
  it("counts the threshold against the model window", () => {
    const s = settings({ warnPct: 70, critPct: 90 });
    expect(promptBudgetLevel(s, promptBudgetPct(699, 1000))).toBe("ok");
    expect(promptBudgetLevel(s, promptBudgetPct(700, 1000))).toBe("warn");
    expect(promptBudgetLevel(s, promptBudgetPct(899, 1000))).toBe("warn");
    expect(promptBudgetLevel(s, promptBudgetPct(900, 1000))).toBe("crit");
  });

  it("the same total grades differently under a different window", () => {
    const s = settings({ warnPct: 70, critPct: 90 });
    const small = buildPromptBudgetRunStatus({
      runId: "r", total: 700, parts: {}, windowTokens: 1000, settings: s,
    });
    const large = buildPromptBudgetRunStatus({
      runId: "r", total: 700, parts: {}, windowTokens: 10_000, settings: s,
    });
    expect(small.level).toBe("warn");
    expect(large.level).toBe("ok");
  });

  it("a settings change is visible to the next evaluation (no restart)", () => {
    // The live-settings rule: the sweep re-reads the row on every pass, so the
    // object the PUT stored is the object the next evaluation resolves
    // against. Pinned here as a pure re-evaluation: same run, new settings.
    const stored = normalizePromptBudgetSettings({ ...settings(), warnPct: 95, critPct: 99 });
    const run = { runId: "r", total: 920, parts: {}, windowTokens: 1000 };
    expect(buildPromptBudgetRunStatus({ ...run, settings: settings() }).level).toBe("crit");
    expect(buildPromptBudgetRunStatus({ ...run, settings: stored }).level).toBe("ok");
  });

  it("a disabled feature never leaves ok", () => {
    const s = settings({ enabled: false });
    expect(promptBudgetLevel(s, 100)).toBe("ok");
    expect(promptBudgetLevel(s, 250)).toBe("ok");
  });
});

describe("myrmidon(1.6.3 PROMPT-BUDGET B) breakdown fallback", () => {
  it("a run with a breakdown reports total and parts", () => {
    const parsed = parsePromptBreakdown({
      promptBreakdown: { parts: { instructions: 400, wake: 300 }, total: 700 },
      inputTokens: 999,
    });
    expect(parsed).toEqual({ total: 700, parts: { instructions: 400, wake: 300 } });
  });

  it("a non-gateway run (no breakdown) signals on its total with no parts", () => {
    const parsed = parsePromptBreakdown({ inputTokens: 950 });
    expect(parsed).toEqual({ total: 950, parts: {} });
    const status = buildPromptBudgetRunStatus({
      runId: "r",
      total: parsed!.total,
      parts: parsed!.parts,
      windowTokens: 1000,
      settings: settings(),
    });
    expect(status.level).toBe("crit");
    expect(status.parts).toEqual({});
  });

  it("rawInputTokens is the second fallback", () => {
    expect(parsePromptBreakdown({ rawInputTokens: 500 })).toEqual({ total: 500, parts: {} });
    expect(parsePromptBreakdown({})).toBeNull();
    expect(parsePromptBreakdown(null)).toBeNull();
  });
});

describe("myrmidon(1.6.3 PROMPT-BUDGET B) attention cards", () => {
  it("a card exists exactly while the last run is over a threshold", () => {
    const names = new Map([[AGENT_A, "agent-a"]] as const);
    const s = settings();
    const over = agentStatus({ settings: s });
    const under = agentStatus({
      settings: s,
      lastRun: buildPromptBudgetRunStatus({
        runId: "run-2", total: 100, parts: {}, windowTokens: 1000, settings: s,
      }),
    });
    const overCards = buildPromptBudgetAttentionCards([over], names);
    expect(overCards).toHaveLength(1);
    expect(overCards[0]!.dedupKey).toBe(`prompt_budget:${AGENT_A}`);
    expect(overCards[0]!.severity).toBe("high"); // crit -> high
    expect(buildPromptBudgetAttentionCards([under], names)).toHaveLength(0);
    // An agent with no usable run never raises a card.
    expect(
      buildPromptBudgetAttentionCards([agentStatus({ settings: s, lastRun: null })], names),
    ).toHaveLength(0);
  });

  it("warn grades medium, crit grades high, and the card re-grades on the next run", () => {
    const names = new Map([[AGENT_A, "agent-a"]] as const);
    const s = settings();
    const warnRun = buildPromptBudgetRunStatus({
      runId: "run-1", total: 800, parts: {}, windowTokens: 1000, settings: s,
    });
    const critRun = buildPromptBudgetRunStatus({
      runId: "run-2", total: 950, parts: {}, windowTokens: 1000, settings: s,
    });
    const warnCards = buildPromptBudgetAttentionCards(
      [agentStatus({ settings: s, lastRun: warnRun })], names,
    );
    expect(warnCards[0]!.severity).toBe("medium");
    const critCards = buildPromptBudgetAttentionCards(
      [agentStatus({ settings: s, lastRun: critRun })], names,
    );
    expect(critCards[0]!.severity).toBe("high");
    // Same dedup key — the feed item updates in place, it does not stack.
    expect(warnCards[0]!.dedupKey).toBe(critCards[0]!.dedupKey);
  });

  it("the detail carries the top-3 parts, the window and the crossed threshold", () => {
    const names = new Map([[AGENT_A, "agent-a"]] as const);
    const s = settings();
    const run = buildPromptBudgetRunStatus({
      runId: "run-1",
      total: 950,
      parts: { instructions: 400, wake: 300, history: 200, tools: 50 },
      windowTokens: 1000,
      settings: s,
    });
    const [card] = buildPromptBudgetAttentionCards([agentStatus({ settings: s, lastRun: run })], names);
    expect(card!.whyNow).toContain("95%");
    expect(card!.whyNow).toContain("1000 tokens");
    expect(card!.whyNow).toContain("crit threshold of 90%");
    expect(card!.whyNow).toContain("instructions 400");
    expect(card!.metadata.topParts).toEqual([
      { name: "instructions", tokens: 400 },
      { name: "wake", tokens: 300 },
      { name: "history", tokens: 200 },
    ]);
  });

  it("a fallback window says so in the detail", () => {
    const names = new Map([[AGENT_A, "agent-a"]] as const);
    const s = settings();
    const status = agentStatus({
      settings: s,
      model: null,
      windowTokens: s.fallbackWindowTokens,
      windowIsFallback: true,
    });
    const [card] = buildPromptBudgetAttentionCards([status], names);
    expect(card!.whyNow).toContain("fallback window");
  });

  it("the feed can emit the prompt_budget_alert kind", () => {
    expect(ATTENTION_SOURCE_KINDS).toContain("prompt_budget_alert");
  });
});

describe("myrmidon(1.6.3 PROMPT-BUDGET B) top parts", () => {
  it("orders by tokens desc with a stable name tiebreak and truncates", () => {
    expect(
      topPromptBudgetParts({ b: 10, a: 10, c: 30, d: 20 }, 3),
    ).toEqual([
      { name: "c", tokens: 30 },
      { name: "d", tokens: 20 },
      { name: "a", tokens: 10 },
    ]);
    expect(topPromptBudgetParts({}, 3)).toEqual([]);
  });
});

describe("myrmidon(1.6.3 PROMPT-BUDGET B) signal dedup", () => {
  it("one comment per agent per window; a second pass in the same window writes nothing", async () => {
    const key = promptBudgetSignalKey(AGENT_A, new Date(Date.UTC(2026, 9, 4)));
    expect(key).toBe(`prompt-budget:${AGENT_A}:2026-10-04`);
    expect(promptBudgetSignalKey(AGENT_B, new Date(Date.UTC(2026, 9, 4)))).not.toBe(key);

    // The delivery seam with fake ports: a db whose "already signalled" check
    // flips after the first write behaves as one comment per window.
    let stored = false;
    let writes = 0;
    const fakeDb = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  orderBy() {
                    return { limit: async () => [{ id: "issue-1", identifier: "T-1" }] };
                  },
                  limit: async () => (stored ? [{ id: "c1" }] : []),
                };
              },
            };
          },
        };
      },
    };
    const ports: PromptBudgetSignalPorts = {
      addComment: async () => {
        writes += 1;
        stored = true;
      },
      now: () => new Date(Date.UTC(2026, 9, 4, 12)),
    };
    const status = agentStatus();
    const first = await deliverPromptBudgetSignal(fakeDb as never, ports, {
      companyId: "company-1",
      status,
      agentName: "agent-a",
    });
    const second = await deliverPromptBudgetSignal(fakeDb as never, ports, {
      companyId: "company-1",
      status,
      agentName: "agent-a",
    });
    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(writes).toBe(1);
  });
});
