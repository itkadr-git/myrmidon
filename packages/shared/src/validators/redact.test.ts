import { describe, expect, it } from "vitest";
import {
  redactConfigSchema,
  redactRuleSchema,
  redactModeSchema,
  redactMaskStyleSchema,
  redactRecognizerSchema,
} from "./redact.js";

const validRecognizer = {
  kind: "secret",
  enabled: true,
};

const validRule = {
  id: "rule-1",
  name: "Secrets redaction",
  mode: "mask",
  maskStyle: "irreversible",
  recognizers: [validRecognizer],
};

const validConfig = {
  version: "1.7.0",
  updatedAt: "2026-11-02T00:00:00.000Z",
  rules: [validRule],
};

describe("redact validators", () => {
  describe("redactModeSchema", () => {
    it.each(["flag", "mask", "block"] as const)("accepts %s", (mode) => {
      expect(redactModeSchema.parse(mode)).toBe(mode);
    });

    it("rejects unknown mode", () => {
      expect(redactModeSchema.safeParse("unknown").success).toBe(false);
    });
  });

  describe("redactMaskStyleSchema", () => {
    it.each(["irreversible", "reversible"] as const)("accepts %s", (style) => {
      expect(redactMaskStyleSchema.parse(style)).toBe(style);
    });

    it("rejects unknown mask style", () => {
      expect(redactMaskStyleSchema.safeParse("both").success).toBe(false);
    });
  });

  describe("redactRecognizerSchema", () => {
    it("rejects unknown fields", () => {
      const result = redactRecognizerSchema.safeParse({
        ...validRecognizer,
        secret: "pcp_xxx",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("redactRuleSchema", () => {
    it("accepts a minimal valid rule", () => {
      const result = redactRuleSchema.safeParse(validRule);
      expect(result.success).toBe(true);
    });

    it("rejects unknown fields", () => {
      const result = redactRuleSchema.safeParse({
        ...validRule,
        extra: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty recognizers array", () => {
      const result = redactRuleSchema.safeParse({
        ...validRule,
        recognizers: [],
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid ttlSeconds", () => {
      const result = redactRuleSchema.safeParse({
        ...validRule,
        ttlSeconds: -1,
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid threshold", () => {
      const result = redactRuleSchema.safeParse({
        ...validRule,
        threshold: 1.5,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-integer priority in recognizer", () => {
      const result = redactRuleSchema.safeParse({
        ...validRule,
        recognizers: [{ ...validRecognizer, priority: 1.5 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects secret-bearing recognizer fields", () => {
      const result = redactRuleSchema.safeParse({
        ...validRule,
        recognizers: [{ ...validRecognizer, apiKey: "sk-abc123" }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("redactConfigSchema", () => {
    it("accepts a valid config", () => {
      const result = redactConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    it("rejects unknown top-level fields", () => {
      const result = redactConfigSchema.safeParse({
        ...validConfig,
        secrets: { key: "value" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects empty rules array", () => {
      const result = redactConfigSchema.safeParse({
        ...validConfig,
        rules: [],
      });
      expect(result.success).toBe(false);
    });

    it("normalizes defaults (mode, maskStyle, ttlSeconds)", () => {
      const parsed = redactConfigSchema.parse({
        version: "1.7.0",
        updatedAt: "2026-11-02T00:00:00.000Z",
        rules: [
          {
            id: "r1",
            name: "Flag only",
            recognizers: [{ kind: "pii" }],
          },
        ],
      });

      expect(parsed.rules[0].mode).toBe("flag");
      expect(parsed.rules[0].maskStyle).toBe("irreversible");
      expect(parsed.rules[0].ttlSeconds).toBe(3600);
      expect(parsed.rules[0].recognizers[0].enabled).toBe(true);
      expect(parsed.rules[0].recognizers[0].priority).toBe(100);
    });

    it("rejects invalid ISO datetime in updatedAt", () => {
      const result = redactConfigSchema.safeParse({
        ...validConfig,
        updatedAt: "not-a-date",
      });
      expect(result.success).toBe(false);
    });
  });
});
