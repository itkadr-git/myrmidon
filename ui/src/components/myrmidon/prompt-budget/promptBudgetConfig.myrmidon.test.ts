// myrmidon(1.6.3 PROMPT-BUDGET B): pure-helper tests of the prompt-budget UI
// config — percent/window parsing, badge text and top-part ordering. No React,
// no network.
import { describe, expect, it } from "vitest";
import {
  numberToText,
  parseFallbackWindow,
  parsePromptPct,
  promptBudgetBadgeText,
  promptBudgetBadgeTitle,
  topParts,
} from "./promptBudgetConfig";
import type { PromptBudgetRunStatus } from "./promptBudgetApi";

function run(overrides: Partial<PromptBudgetRunStatus> = {}): PromptBudgetRunStatus {
  return { runId: "r1", total: 950, parts: {}, pct: 95, level: "crit", ...overrides };
}

describe("myrmidon(1.6.3 PROMPT-BUDGET B) promptBudgetConfig", () => {
  it("parses a whole percent in range and rejects the rest", () => {
    expect(parsePromptPct("70")).toEqual({ ok: true, value: 70 });
    expect(parsePromptPct("1")).toEqual({ ok: true, value: 1 });
    expect(parsePromptPct("100")).toEqual({ ok: true, value: 100 });
    expect(parsePromptPct("0").ok).toBe(false);
    expect(parsePromptPct("101").ok).toBe(false);
    expect(parsePromptPct("7.5").ok).toBe(false);
    expect(parsePromptPct("").ok).toBe(false);
    expect(parsePromptPct("abc").ok).toBe(false);
  });

  it("parses a fallback window of at least 1000 tokens", () => {
    expect(parseFallbackWindow("200000")).toEqual({ ok: true, value: 200000 });
    expect(parseFallbackWindow("1000")).toEqual({ ok: true, value: 1000 });
    expect(parseFallbackWindow("999").ok).toBe(false);
    expect(parseFallbackWindow("").ok).toBe(false);
  });

  it("renders numbers to input drafts", () => {
    expect(numberToText(70)).toBe("70");
    expect(numberToText(null)).toBe("");
    expect(numberToText(undefined)).toBe("");
  });

  it("the badge text is the last run's share", () => {
    expect(promptBudgetBadgeText(run())).toBe("95%");
    expect(promptBudgetBadgeText(run({ pct: 7.5, level: "ok" }))).toBe("7.5%");
  });

  it("the badge title carries the totals and the top parts", () => {
    const titled = promptBudgetBadgeTitle(
      run({ parts: { instructions: 400, wake: 300, tools: 50 } }),
      1000,
    );
    expect(titled).toContain("95%");
    expect(titled).toContain("950/1000");
    expect(titled).toContain("instructions 400");
    expect(titled).toContain("wake 300");
  });

  it("a run without parts yields a title without a part list", () => {
    expect(promptBudgetBadgeTitle(run(), 1000)).not.toContain("biggest");
  });

  it("topParts orders by tokens desc with a stable name tiebreak and truncates", () => {
    expect(topParts({ b: 10, a: 10, c: 30, d: 20 }, 3)).toEqual([
      { name: "c", tokens: 30 },
      { name: "d", tokens: 20 },
      { name: "a", tokens: 10 },
    ]);
    expect(topParts({}, 3)).toEqual([]);
  });
});
