import { describe, expect, it } from "vitest";
import { readInputLimitHint } from "@paperclipai/adapter-utils/input-limit";
import { decideSessionReset, promptTokensOf, readInputLimitSettings } from "./input-limit.js";

const hint = readInputLimitHint({ model: "m", maxInputTokens: 1000 })!; // budget 900 tokens

describe("readInputLimitSettings", () => {
  it("is on by default with the documented ratios", () => {
    expect(readInputLimitSettings({})).toEqual({ enabled: true, charsPerToken: 3, safety: 0.9 });
  });

  it("can be turned off and tuned, ignoring nonsense", () => {
    expect(readInputLimitSettings({ MYRMIDON_INPUT_LIMIT_PRECHECK: "0" }).enabled).toBe(false);
    expect(readInputLimitSettings({ MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN: "4", MYRMIDON_INPUT_LIMIT_SAFETY: "0.8" })).toMatchObject({
      charsPerToken: 4,
      safety: 0.8,
    });
    expect(readInputLimitSettings({ MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN: "x", MYRMIDON_INPUT_LIMIT_SAFETY: "7" })).toMatchObject({
      charsPerToken: 3,
      safety: 0.9,
    });
  });
});

describe("promptTokensOf", () => {
  it("reads the breakdown total from the first source that has one", () => {
    expect(promptTokensOf(null, { promptBreakdown: { total: 42 } })).toBe(42);
    expect(promptTokensOf({ promptBreakdown: { total: 7 } }, { promptBreakdown: { total: 42 } })).toBe(7);
  });

  it("is 0 without a usable total", () => {
    expect(promptTokensOf(null, undefined, { promptBreakdown: { total: 0 } }, { inputTokens: 99 })).toBe(0);
  });
});

describe("decideSessionReset", () => {
  it("keeps a session that still has room for the next prompt", () => {
    expect(decideSessionReset(hint, { sessionTokens: 500, lastPromptTokens: 300, runs: 2 })).toEqual({ reset: false });
  });

  it("resets when the session plus a prompt like the last one would exceed the budget", () => {
    expect(decideSessionReset(hint, { sessionTokens: 700, lastPromptTokens: 300, runs: 3 })).toEqual({
      reset: true,
      sessionTokens: 700,
      expectedTokens: 1000,
      budgetTokens: 900,
    });
  });

  it("never resets a session nothing is known to be in", () => {
    expect(decideSessionReset(hint, { sessionTokens: 0, lastPromptTokens: 0, runs: 0 })).toEqual({ reset: false });
  });
});
