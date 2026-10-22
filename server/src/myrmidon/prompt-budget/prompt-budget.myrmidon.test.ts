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
import { agents, companies } from "@paperclipai/db";
import {
  ATTENTION_SOURCE_KINDS,
  PROMPT_BUDGET_SETTINGS_KEY,
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
import {
  hasPromptBudgetSignal,
  promptBudgetSignalWindowStart,
  readPromptBudgetSignals,
  refreshPromptBudgetSignals,
  resetPromptBudgetSignals,
} from "./signal.js";
import { PROMPT_BUDGET_SIGNAL_NOTICE_TITLE, isPromptBudgetSignalNotice } from "./notice.js";
import { createPromptBudgetSweeper } from "./sweep.js";
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

/** The sweeper's db, reduced to the two selects a pass makes. */
function fakeSweepDb() {
  return {
    select(_shape?: unknown) {
      return {
        from(table: unknown) {
          return {
            where: async () =>
              table === companies
                ? [{ id: "company-1" }]
                : [{ id: AGENT_A, name: "agent-a" }],
          };
        },
      };
    },
  };
}

/** The instance-settings seam the sweep reads the thresholds from. */
function fakeSweepSettings(overrides: Partial<PromptBudgetSettings> = {}) {
  const stored = settings(overrides);
  return {
    getGeneral: async () => ({ [PROMPT_BUDGET_SETTINGS_KEY]: stored }),
    updateGeneral: async () => {},
  };
}

describe("myrmidon(1.6.5 PROMPT-BUDGET-SIGNAL) recorded signal dedup", () => {
  it("one signal per agent per UTC day: a second pass over the threshold holds the record instead of repeating it", () => {
    resetPromptBudgetSignals();
    const key = promptBudgetSignalKey(AGENT_A, new Date(Date.UTC(2026, 9, 4)));
    expect(key).toBe(`prompt-budget:${AGENT_A}:2026-10-04`);
    expect(promptBudgetSignalKey(AGENT_B, new Date(Date.UTC(2026, 9, 4)))).not.toBe(key);

    const cards = buildPromptBudgetAttentionCards(
      [agentStatus()],
      new Map([[AGENT_A, "agent-a"]]),
    );
    expect(cards).toHaveLength(1);

    // The sweep's first pass of the day records the signal under its day key.
    const firstPass = new Date(Date.UTC(2026, 9, 4, 9, 0));
    expect(refreshPromptBudgetSignals("company-1", cards, firstPass)).toEqual({
      cards: 1,
      recorded: 1,
      held: 0,
    });
    expect(
      hasPromptBudgetSignal("company-1", AGENT_A, promptBudgetSignalWindowStart(firstPass)),
    ).toBe(true);
    // The key is per agent and per company: neither neighbour is "already sent".
    expect(
      hasPromptBudgetSignal("company-1", AGENT_B, promptBudgetSignalWindowStart(firstPass)),
    ).toBe(false);
    expect(
      hasPromptBudgetSignal("company-2", AGENT_A, promptBudgetSignalWindowStart(firstPass)),
    ).toBe(false);

    // The next pass of the same loop, two hours later, same UTC day: the
    // record is found and held — nothing repeats.
    const secondPass = new Date(Date.UTC(2026, 9, 4, 11, 0));
    expect(refreshPromptBudgetSignals("company-1", cards, secondPass)).toEqual({
      cards: 1,
      recorded: 0,
      held: 1,
    });
    const recorded = readPromptBudgetSignals("company-1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.key).toBe(key);
    expect(recorded[0]!.recordedAt).toBe(firstPass.toISOString());
    expect(recorded[0]!.card.dedupKey).toBe(cards[0]!.dedupKey);
  });

  it("a re-grade in the same day updates the record in place; the next UTC day records one new signal", () => {
    resetPromptBudgetSignals();
    const firstPass = new Date(Date.UTC(2026, 9, 4, 9, 0));
    const warn = buildPromptBudgetAttentionCards(
      [agentStatus()],
      new Map([[AGENT_A, "agent-a"]]),
    );
    refreshPromptBudgetSignals("company-1", warn, firstPass);

    // warn -> crit on a newer run, same UTC day: one record, fresh numbers.
    const crit = buildPromptBudgetAttentionCards(
      [
        agentStatus({
          lastRun: buildPromptBudgetRunStatus({
            runId: "run-2",
            total: 990,
            parts: {},
            windowTokens: 1000,
            settings: settings(),
          }),
        }),
      ],
      new Map([[AGENT_A, "agent-a"]]),
    );
    expect(
      refreshPromptBudgetSignals("company-1", crit, new Date(Date.UTC(2026, 9, 4, 12, 0))),
    ).toEqual({ cards: 1, recorded: 0, held: 1 });
    const held = readPromptBudgetSignals("company-1");
    expect(held).toHaveLength(1);
    expect(held[0]!.recordedAt).toBe(firstPass.toISOString());
    expect(held[0]!.card.severity).toBe(crit[0]!.severity);

    // A new UTC day is one new signal of the day — still one per agent.
    const nextDay = new Date(Date.UTC(2026, 9, 5, 0, 5));
    expect(refreshPromptBudgetSignals("company-1", crit, nextDay)).toEqual({
      cards: 1,
      recorded: 1,
      held: 0,
    });
    const nextSignal = readPromptBudgetSignals("company-1");
    expect(nextSignal).toHaveLength(1);
    expect(nextSignal[0]!.key).toBe(`prompt-budget:${AGENT_A}:2026-10-05`);
    expect(nextSignal[0]!.recordedAt).toBe(nextDay.toISOString());

    // Back under the threshold: the record goes, and with it the card.
    expect(
      refreshPromptBudgetSignals("company-1", [], new Date(Date.UTC(2026, 9, 5, 12, 0))),
    ).toEqual({ cards: 0, recorded: 0, held: 0 });
    expect(readPromptBudgetSignals("company-1")).toEqual([]);
    expect(
      hasPromptBudgetSignal("company-1", AGENT_A, promptBudgetSignalWindowStart(nextDay)),
    ).toBe(false);
  });
});

describe("myrmidon(1.6.5 PROMPT-BUDGET-SIGNAL) sweep over the threshold", () => {
  it("two passes in a row over the threshold: one recorded card, zero comments in the agent's task", async () => {
    resetPromptBudgetSignals();
    const firstPass = new Date(Date.UTC(2026, 9, 4, 9, 0));
    const secondPass = new Date(Date.UTC(2026, 9, 4, 11, 0));
    // The sweeper's whole wiring: no comment port exists to write into a task,
    // which is the regression guard for "the agent is never woken by this".
    const deps = {
      db: fakeSweepDb() as never,
      settings: fakeSweepSettings() as never,
      readStatus: async () => [agentStatus()],
      now: () => firstPass,
    };
    expect(Object.keys(deps)).toEqual(["db", "settings", "readStatus", "now"]);

    const sweeper = createPromptBudgetSweeper(deps);
    const first = await sweeper.sweep(firstPass, { force: true });
    expect(first).toMatchObject({
      skipped: false,
      inspected: 1,
      signaled: 1,
      held: 0,
      failed: 0,
    });
    const second = await sweeper.sweep(secondPass, { force: true });
    expect(second).toMatchObject({
      skipped: false,
      inspected: 1,
      signaled: 0,
      held: 1,
      failed: 0,
    });

    // One card, and the card is the signal's only surface.
    const signals = readPromptBudgetSignals("company-1");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.card.agentId).toBe(AGENT_A);
    expect(signals[0]!.recordedAt).toBe(firstPass.toISOString());
  });

  it("a disabled feature records no signal and clears the card of the day", async () => {
    resetPromptBudgetSignals();
    const now = new Date(Date.UTC(2026, 9, 4, 9, 0));
    const enabled = createPromptBudgetSweeper({
      db: fakeSweepDb() as never,
      settings: fakeSweepSettings() as never,
      readStatus: async () => [agentStatus()],
      now: () => now,
    });
    expect((await enabled.sweep(now, { force: true })).signaled).toBe(1);
    expect(readPromptBudgetSignals("company-1")).toHaveLength(1);

    const disabled = createPromptBudgetSweeper({
      db: fakeSweepDb() as never,
      settings: fakeSweepSettings({ enabled: false }) as never,
      readStatus: async () => [agentStatus()],
      now: () => now,
    });
    const off = await disabled.sweep(now, { force: true });
    expect(off.signaled).toBe(0);
    expect(off.inspected).toBe(0);
    expect(readPromptBudgetSignals("company-1")).toEqual([]);
  });
});

describe("myrmidon(1.6.5 PROMPT-BUDGET-SIGNAL) notice recognition", () => {
  it("recognises the signal comment by its system_notice title, or by its body when the row lost the presentation", () => {
    const body =
      "work-gip's last run used 124.8% of its prompt window (249600 of 200000 tokens).";
    expect(
      isPromptBudgetSignalNotice({
        authorType: "system",
        presentation: { kind: "system_notice", title: PROMPT_BUDGET_SIGNAL_NOTICE_TITLE },
        body,
      }),
    ).toBe(true);
    // The production rows: the insert dropped the metadata, so the sentence is
    // the only marker left on them.
    expect(
      isPromptBudgetSignalNotice({ authorType: "system", presentation: null, body }),
    ).toBe(true);
    // A person quoting the sentence is not the signal, and neither is another
    // system notice.
    expect(
      isPromptBudgetSignalNotice({ authorType: "user", presentation: null, body }),
    ).toBe(false);
    expect(
      isPromptBudgetSignalNotice({ authorType: "system", presentation: null, body: "Done." }),
    ).toBe(false);
    expect(
      isPromptBudgetSignalNotice({
        authorType: "system",
        presentation: { kind: "system_notice", title: "Another notice" },
        body: "Done.",
      }),
    ).toBe(false);
  });
});
