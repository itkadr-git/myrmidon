import { describe, expect, it } from "vitest";

import {
  estimateTokens,
  measureSections,
  PROMPT_METER_CHARS_PER_TOKEN,
} from "./prompt-meter.js";

describe("estimateTokens", () => {
  it("estimates empty and missing input as zero", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("uses the chars-per-token heuristic, rounding up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(PROMPT_METER_CHARS_PER_TOKEN * 10))).toBe(10);
    expect(estimateTokens("a".repeat(PROMPT_METER_CHARS_PER_TOKEN * 10 + 1))).toBe(11);
  });

  it("is deterministic for a realistic mixed prompt", () => {
    const sample = [
      "You are Test Agent, an AI agent employee in a Paperclip-managed company.",
      "",
      "## Task",
      "",
      "- Implement the change",
      "- Run the tests",
      "",
      "```json",
      JSON.stringify({ reason: "issue_assigned", issueId: "abc-123" }),
      "```",
    ].join("\n");
    const expected = Math.ceil(sample.length / PROMPT_METER_CHARS_PER_TOKEN);
    expect(estimateTokens(sample)).toBe(expected);
    expect(estimateTokens(sample)).toBe(estimateTokens(sample));
  });
});

describe("measureSections", () => {
  it("returns per-part estimates whose sum equals total exactly", () => {
    const identity = "You are Hermes, an AI agent employee.";
    const wakePrompt = "Paperclip Wake Payload\n\n- reason: issue_assigned";
    const taskMarkdown = "x".repeat(401); // deliberately not a multiple of 4
    const breakdown = measureSections({
      identityContract: identity,
      wakePrompt,
      taskMarkdown,
    });

    expect(breakdown.parts).toEqual({
      identityContract: estimateTokens(identity),
      wakePrompt: estimateTokens(wakePrompt),
      taskMarkdown: Math.ceil(401 / PROMPT_METER_CHARS_PER_TOKEN),
    });
    const partSum = Object.values(breakdown.parts).reduce((a, b) => a + b, 0);
    expect(breakdown.total).toBe(partSum);
  });

  it("omits empty and missing sections but still totals the rest", () => {
    const breakdown = measureSections({
      identityContract: "abcd",
      wakePrompt: "",
      sessionHandoff: null,
      taskMarkdown: undefined,
      wakePayloadJson: "abcdefgh",
    });

    expect(breakdown.parts).toEqual({
      identityContract: 1,
      wakePayloadJson: 2,
    });
    expect(breakdown.total).toBe(3);
  });

  it("returns a zero-total empty breakdown when every section is empty", () => {
    expect(measureSections({})).toEqual({ parts: {}, total: 0 });
    expect(measureSections({ a: "", b: null })).toEqual({ parts: {}, total: 0 });
  });
});

describe("measureSections with joined total (ported from #558)", () => {
  it("measures the total against the exact joined text when provided", () => {
    const sections = { one: "a".repeat(400), two: "b".repeat(40) };
    const joined = `${sections.one}\n\n---\n\n${sections.two}`;
    const result = measureSections(sections, { joined });
    expect(result.parts).toEqual({ one: 100, two: 10 });
    expect(result.total).toBe(Math.ceil(joined.length / PROMPT_METER_CHARS_PER_TOKEN));
  });

  it("is monotone in text size", () => {
    const small = estimateTokens("hello world");
    const large = estimateTokens("hello world".repeat(100));
    expect(large).toBeGreaterThan(small);
  });
});
