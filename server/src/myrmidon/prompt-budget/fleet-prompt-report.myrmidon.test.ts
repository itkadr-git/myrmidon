// server/src/myrmidon/prompt-budget/fleet-prompt-report.myrmidon.test.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET D): guard tests for the fleet prompt report.
//
// Red side (main without this change): `costService.byAgent` returns rows with
// no prompt columns and this module does not exist, so every assertion below
// fails — the aggregates, the input-token fallback of a run without a
// breakdown, and the empty share when the threshold settings are absent.

import { describe, expect, it } from "vitest";
import {
  aggregateAgentPromptStats,
  extractPromptTokens,
  normalizePromptBudgetSettings,
  promptThresholdTokens,
  type PromptRunInput,
} from "./fleet-prompt-report.js";

const WINDOW = 100_000;

function run(
  agentId: string,
  runId: string,
  promptTokens: number,
  model: string | null = "model-a",
): PromptRunInput {
  return { agentId, runId, promptTokens, model };
}

describe("myrmidon(1.6.3 PROMPT-BUDGET D) prompt size of a run", () => {
  it("prefers the recorded prompt breakdown total", () => {
    const usage = { promptBreakdown: { parts: { instructions: 900, skills: 100 }, total: 1_000 } };
    expect(extractPromptTokens(usage, 42)).toBe(1_000);
  });

  it("falls back to the run input tokens when the run has no breakdown", () => {
    expect(extractPromptTokens({ inputTokens: 7 }, 1_234)).toBe(1_234);
    expect(extractPromptTokens(null, 5)).toBe(5);
  });

  it("does not treat a malformed breakdown as a prompt size", () => {
    expect(extractPromptTokens({ promptBreakdown: { total: "lots" } }, 321)).toBe(321);
    expect(extractPromptTokens({ promptBreakdown: { total: -1 } }, 654)).toBe(654);
    expect(extractPromptTokens({ promptBreakdown: {} }, 99)).toBe(99);
  });

  it("returns nothing when neither source holds a size", () => {
    expect(extractPromptTokens(null, null)).toBeNull();
    expect(extractPromptTokens({ promptBreakdown: { total: "nope" } }, null)).toBeNull();
  });
});

describe("myrmidon(1.6.3 PROMPT-BUDGET D) threshold settings", () => {
  it("reads the frozen contract shape", () => {
    expect(normalizePromptBudgetSettings({ enabled: true, warnPct: 70, critPct: 90 })).toEqual({
      enabled: true,
      warnPct: 70,
      critPct: 90,
    });
  });

  it("treats absent, disabled and unusable settings as no threshold", () => {
    expect(normalizePromptBudgetSettings(undefined)).toBeNull();
    expect(normalizePromptBudgetSettings(null)).toBeNull();
    expect(normalizePromptBudgetSettings({ enabled: false, warnPct: 70, critPct: 90 })).toBeNull();
    expect(normalizePromptBudgetSettings({ enabled: true, critPct: 90 })).toBeNull();
    expect(normalizePromptBudgetSettings({ enabled: true, warnPct: 0, critPct: 90 })).toBeNull();
    expect(normalizePromptBudgetSettings({ enabled: true, warnPct: "huge", critPct: 90 })).toBeNull();
  });

  it("mirrors the warning level when the critical one is unusable", () => {
    expect(normalizePromptBudgetSettings({ enabled: true, warnPct: 70 })).toEqual({
      enabled: true,
      warnPct: 70,
      critPct: 70,
    });
  });

  it("computes the absolute threshold from the model window", () => {
    const settings = { enabled: true, warnPct: 50, critPct: 90 };
    expect(promptThresholdTokens(settings, WINDOW)).toBe(50_000);
    expect(promptThresholdTokens(settings, null)).toBeNull();
    expect(promptThresholdTokens(settings, 0)).toBeNull();
    expect(promptThresholdTokens(null, WINDOW)).toBeNull();
  });
});

describe("myrmidon(1.6.3 PROMPT-BUDGET D) per-agent aggregates", () => {
  const runs: PromptRunInput[] = [
    run("agent-a", "run-a1", 1_000),
    run("agent-a", "run-a2", 3_000),
    run("agent-b", "run-b1", 6_000),
  ];

  it("averages the prompt size per agent", () => {
    const stats = aggregateAgentPromptStats(runs, null, new Map());

    expect(stats.get("agent-a")?.avgPromptTokens).toBe(2_000);
    expect(stats.get("agent-b")?.avgPromptTokens).toBe(6_000);
  });

  it("keeps the share empty while no threshold is configured", () => {
    const stats = aggregateAgentPromptStats(runs, null, new Map([["model-a", WINDOW]]));

    expect(stats.get("agent-a")?.runsAboveThresholdPct).toBeNull();
    expect(stats.get("agent-b")?.runsAboveThresholdPct).toBeNull();
  });

  it("shares only the runs whose model window is known", () => {
    const settings = { enabled: true, warnPct: 50, critPct: 90 };
    const mixed: PromptRunInput[] = [
      run("agent-a", "run-a1", 1_000),
      run("agent-a", "run-a2", 60_000),
      run("agent-a", "run-a3", 90_000, "model-unknown"),
    ];
    const stats = aggregateAgentPromptStats(mixed, settings, new Map([["model-a", WINDOW]]));

    // run-a2 is above 50% of the window, run-a1 is not, run-a3 cannot be judged.
    expect(stats.get("agent-a")?.runsAboveThresholdPct).toBe(50);
    // ... and the unjudged run still counts towards the average prompt size.
    expect(stats.get("agent-a")?.avgPromptTokens).toBe(Math.round((1_000 + 60_000 + 90_000) / 3));
  });

  it("counts a run once and drops runs without prompt data", () => {
    const duplicates: PromptRunInput[] = [run("agent-a", "run-a1", 1_000), run("agent-a", "run-a1", 1_000)];
    const stats = aggregateAgentPromptStats(duplicates, null, new Map());

    expect(stats.get("agent-a")?.avgPromptTokens).toBe(1_000);
    expect(aggregateAgentPromptStats([], null, new Map()).size).toBe(0);
  });

  it("reports every run above the threshold", () => {
    const settings = { enabled: true, warnPct: 50, critPct: 90 };
    const above: PromptRunInput[] = [
      run("agent-a", "run-a1", 1_000),
      run("agent-b", "run-b1", 60_000),
      run("agent-b", "run-b2", 70_000),
    ];
    const stats = aggregateAgentPromptStats(above, settings, new Map([["model-a", WINDOW]]));

    expect(stats.get("agent-a")?.runsAboveThresholdPct).toBe(0);
    expect(stats.get("agent-b")?.runsAboveThresholdPct).toBe(100);
  });
});