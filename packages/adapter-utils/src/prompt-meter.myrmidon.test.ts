import { describe, expect, it } from "vitest";

import { estimateTokens, measureSections } from "./prompt-meter.js";

describe("estimateTokens", () => {
  it("returns 0 for empty and whitespace-only input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   \n\t  ")).toBe(0);
  });

  it("estimates ~1 token per 4 chars, rounded up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("is monotone in text size", () => {
    const small = estimateTokens("hello world");
    const large = estimateTokens("hello world".repeat(100));
    expect(large).toBeGreaterThan(small);
  });
});

describe("measureSections", () => {
  it("measures each part and totals the joined prompt", () => {
    const result = measureSections({
      instructions: "a".repeat(400),
      wakePrompt: "b".repeat(40),
    });
    expect(result.parts).toEqual({ instructions: 100, wakePrompt: 10 });
    // joined with "\n": 440 + 1 char separator => ceil(441/4) = 111
    expect(result.total).toBe(111);
  });

  it("measures the total against the exact joined text when provided", () => {
    const sections = { one: "a".repeat(400), two: "b".repeat(40) };
    const joined = `${sections.one}\n\n---\n\n${sections.two}`;
    const result = measureSections(sections, { joined });
    expect(result.parts).toEqual({ one: 100, two: 10 });
    expect(result.total).toBe(Math.ceil(joined.length / 4));
  });

  it("returns an empty parts map and zero total for no sections", () => {
    expect(measureSections({})).toEqual({ parts: {}, total: 0 });
  });
});
