// packages/shared/src/myrmidon-guardrail-regex.test.ts
import { describe, it, expect } from "vitest";
import {
  analyzeReDoSRisk,
  validateGuardrailRegex,
  validateGuardrailRegexRequestSchema,
} from "./myrmidon-guardrail-regex.js";

describe("validateGuardrailRegexRequestSchema", () => {
  it("accepts valid pattern without flags or test inputs", () => {
    const parsed = validateGuardrailRegexRequestSchema.parse({
      pattern: "sk-ant-[A-Za-z0-9_-]{20,}",
    });
    expect(parsed.pattern).toBe("sk-ant-[A-Za-z0-9_-]{20,}");
    expect(parsed.flags).toBe("");
  });

  it("accepts valid pattern with valid flags and test inputs", () => {
    const parsed = validateGuardrailRegexRequestSchema.parse({
      pattern: "[a-z]+@[a-z]+\\.[a-z]+",
      flags: "i",
      testInputs: ["test@example.com", "not-an-email"],
    });
    expect(parsed.pattern).toBe("[a-z]+@[a-z]+\\.[a-z]+");
    expect(parsed.flags).toBe("i");
    expect(parsed.testInputs).toEqual(["test@example.com", "not-an-email"]);
  });

  it("rejects empty or whitespace-only pattern", () => {
    expect(() =>
      validateGuardrailRegexRequestSchema.parse({
        pattern: "   ",
      }),
    ).toThrow();
  });

  it("rejects invalid RegExp flags", () => {
    expect(() =>
      validateGuardrailRegexRequestSchema.parse({
        pattern: "foo",
        flags: "iz",
      }),
    ).toThrow();
  });

  it("rejects duplicate RegExp flags", () => {
    expect(() =>
      validateGuardrailRegexRequestSchema.parse({
        pattern: "foo",
        flags: "ii",
      }),
    ).toThrow();
  });
});

describe("analyzeReDoSRisk", () => {
  it("marks invalid regex syntax as invalid", () => {
    const result = analyzeReDoSRisk("(?<invalid");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.redosRisk).toBe(false);
  });

  it("identifies safe literal and character class regexes as safe", () => {
    const result = analyzeReDoSRisk("bearer_token_[a-f0-9]{32}");
    expect(result.valid).toBe(true);
    expect(result.redosRisk).toBe(false);
    expect(result.riskReason).toBeUndefined();
    expect(result.complexity).toBe("low");
  });

  it("identifies safe anchored regexes", () => {
    const result = analyzeReDoSRisk("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$");
    expect(result.valid).toBe(true);
    expect(result.redosRisk).toBe(false);
    expect(result.complexity).toBe("low");
  });

  it("flags nested quantifiers (a+)+ as ReDoS risk", () => {
    const result = analyzeReDoSRisk("(a+)+");
    expect(result.valid).toBe(true);
    expect(result.redosRisk).toBe(true);
    expect(result.riskReason).toContain("Nested quantifiers");
    expect(result.complexity).toBe("vulnerable");
  });

  it("flags nested quantifiers ([0-9]+)* as ReDoS risk", () => {
    const result = analyzeReDoSRisk("([0-9]+)*");
    expect(result.valid).toBe(true);
    expect(result.redosRisk).toBe(true);
    expect(result.riskReason).toContain("Nested quantifiers");
  });

  it("flags overlapping alternatives (a|ab)+ as ReDoS risk", () => {
    const result = analyzeReDoSRisk("(a|ab)+");
    expect(result.valid).toBe(true);
    expect(result.redosRisk).toBe(true);
    expect(result.riskReason).toContain("Overlapping alternatives");
  });

  it("flags duplicate alternatives (foo|foo)+ as ReDoS risk", () => {
    const result = analyzeReDoSRisk("(foo|foo)+");
    expect(result.valid).toBe(true);
    expect(result.redosRisk).toBe(true);
    expect(result.riskReason).toContain("Duplicate alternatives");
  });

  it("flags adjacent wildcards .*.* as ReDoS risk", () => {
    const result = analyzeReDoSRisk("foo.*.*bar");
    expect(result.valid).toBe(true);
    expect(result.redosRisk).toBe(true);
    expect(result.riskReason).toContain("Adjacent unconstrained wildcards");
  });
});

describe("validateGuardrailRegex", () => {
  it("validates safe regex and evaluates sample test inputs", () => {
    const result = validateGuardrailRegex({
      pattern: "\\bsk-[a-zA-Z0-9]{10,}\\b",
      flags: "i",
      testInputs: [
        "Found key: sk-abcdefghij123 in log",
        "No key here sk-short",
        "Normal message without tokens",
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.redosRisk).toBe(false);
    expect(result.sampleMatches).toHaveLength(3);
    expect(result.sampleMatches![0]).toEqual({
      input: "Found key: sk-abcdefghij123 in log",
      matched: true,
    });
    expect(result.sampleMatches![1]).toEqual({
      input: "No key here sk-short",
      matched: false,
    });
    expect(result.sampleMatches![2]).toEqual({
      input: "Normal message without tokens",
      matched: false,
    });
  });

  it("returns invalid result on syntax error", () => {
    const result = validateGuardrailRegex({
      pattern: "(unclosed group",
      flags: "",
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.redosRisk).toBe(false);
    expect(result.sampleMatches).toBeUndefined();
  });

  it("returns valid result with redos warning for vulnerable patterns", () => {
    const result = validateGuardrailRegex({
      pattern: "(x+x+)+y",
      flags: "",
      testInputs: ["xxxxxx"],
    });

    expect(result.valid).toBe(true);
    expect(result.redosRisk).toBe(true);
    expect(result.riskReason).toBeDefined();
    expect(result.complexity).toBe("vulnerable");
    expect(result.sampleMatches).toHaveLength(1);
    expect(result.sampleMatches![0].matched).toBe(false);
  });
});
