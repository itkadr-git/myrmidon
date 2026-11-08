import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHARS_PER_TOKEN,
  MIN_TRIMMED_INPUT_CHARS,
  decideInputLimit,
  estimateTokensFromChars,
  inputBudgetChars,
  inputBudgetTokens,
  inputLimitChars,
  readInputLimitHint,
  trimTextToChars,
} from "./input-limit.js";

const hint = (extra: Record<string, unknown> = {}) =>
  readInputLimitHint({ model: "m", source: "catalog", maxInputTokens: 1000, ...extra })!;

describe("readInputLimitHint", () => {
  it("returns null for anything without a positive limit", () => {
    expect(readInputLimitHint(null)).toBeNull();
    expect(readInputLimitHint([])).toBeNull();
    expect(readInputLimitHint({})).toBeNull();
    expect(readInputLimitHint({ maxInputTokens: 0 })).toBeNull();
    expect(readInputLimitHint({ maxInputTokens: "abc" })).toBeNull();
  });

  it("fills defaults and accepts numeric strings", () => {
    const h = readInputLimitHint({ maxInputTokens: "2000" })!;
    expect(h).toMatchObject({ maxInputTokens: 2000, maxInputChars: null, charsPerToken: DEFAULT_CHARS_PER_TOKEN, source: "catalog" });
    expect(h.safety).toBe(0.9);
  });

  it("ignores a safety factor above 1", () => {
    expect(readInputLimitHint({ maxInputTokens: 10, safety: 2 })!.safety).toBe(0.9);
  });
});

describe("limits", () => {
  it("converts tokens to characters with the configured ratio", () => {
    expect(inputLimitChars(hint({ charsPerToken: 4 }))).toBe(4000);
    expect(inputBudgetChars(hint({ charsPerToken: 4 }))).toBe(3600);
    expect(inputBudgetTokens(hint())).toBe(900);
  });

  it("uses the tighter of the character and token limits", () => {
    expect(inputLimitChars(hint({ maxInputChars: 1500 }))).toBe(1500);
    expect(inputLimitChars(hint({ maxInputChars: 99999 }))).toBe(3000);
  });

  it("estimates tokens conservatively", () => {
    expect(estimateTokensFromChars(10)).toBe(4);
    expect(estimateTokensFromChars(0)).toBe(0);
  });
});

describe("decideInputLimit", () => {
  it("sends a request under the budget", () => {
    const d = decideInputLimit({ hint: hint({ maxInputTokens: 100_000 }), instructionsChars: 1000, inputChars: 5000 });
    expect(d.action).toBe("send");
  });

  it("trims the input to what is left after the instructions", () => {
    const d = decideInputLimit({ hint: hint({ maxInputTokens: 10_000 }), instructionsChars: 6000, inputChars: 50_000 });
    expect(d).toMatchObject({ action: "trim", budgetChars: 27_000, targetInputChars: 21_000 });
  });

  it("never trims the input below the minimum", () => {
    const d = decideInputLimit({ hint: hint({ maxInputTokens: 100 }), instructionsChars: 9000, inputChars: 50_000 });
    expect(d).toMatchObject({ action: "trim", targetInputChars: MIN_TRIMMED_INPUT_CHARS });
  });

  it("does not grow a small input to the minimum", () => {
    const d = decideInputLimit({ hint: hint({ maxInputTokens: 100 }), instructionsChars: 9000, inputChars: 1000 });
    expect(d).toMatchObject({ action: "trim", targetInputChars: 1000 });
  });
});

describe("trimTextToChars", () => {
  it("leaves a short text untouched", () => {
    expect(trimTextToChars("abc", 10)).toEqual({ text: "abc", removedChars: 0 });
  });

  it("fits the limit exactly even when the omitted count changes digit length", () => {
    for (const max of [300, 1000, 1234, 5000]) {
      const out = trimTextToChars("y".repeat(max + 10), max);
      expect(out.text.length).toBeLessThanOrEqual(max);
    }
  });

  it("keeps head and tail, marks the cut and respects the limit", () => {
    const text = `HEAD${"x".repeat(10_000)}TAIL`;
    const out = trimTextToChars(text, 2000);
    expect(out.text.length).toBeLessThanOrEqual(2000);
    expect(out.text.startsWith("HEAD")).toBe(true);
    expect(out.text.endsWith("TAIL")).toBe(true);
    expect(out.text).toContain("characters omitted");
    expect(out.removedChars).toBeGreaterThan(8000);
    expect(out.text).toContain(`${out.removedChars} characters omitted`);
  });
});
