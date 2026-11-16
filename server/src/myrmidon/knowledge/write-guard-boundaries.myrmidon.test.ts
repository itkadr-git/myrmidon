import { describe, expect, it } from "vitest";
import {
  assertKnowledgeWriteProtection,
  detectKnowledgeWriteProtectionViolation,
  KnowledgeDomainError,
} from "./domain.js";

describe("knowledge write guard boundaries", () => {
  const previous100 = "p".repeat(100);
  const previous200 = "p".repeat(200);

  it.each([
    ["19 characters", "x".repeat(19), previous100, "short_single_line"],
    ["20 characters at 20%", "x".repeat(20), previous100, null],
    ["39 characters below 20%", "x".repeat(39), previous200, "severe_truncation"],
    ["40 characters at 20%", "x".repeat(40), previous200, null],
    ["short multiline at 20%", "x\n" + "x".repeat(18), previous100, null],
    ["short multiline below 20%", "x\nx", previous100, "severe_truncation"],
    ["probe takes precedence", "__probe", previous100, "probe_marker"],
    ["probe on create", "__probe", null, "probe_marker"],
    ["short stub on create", "stub", null, null],
    ["short stub after empty content", "stub", "", null],
    ["empty update", "  \n ", previous100, "short_single_line"],
  ] as const)("detects %s", (_name, newContent, previousContent, kind) => {
    const input = Object.freeze({ newContent, previousContent });
    const before = { ...input };
    expect(detectKnowledgeWriteProtectionViolation(input)?.kind ?? null).toBe(kind);
    if (kind === null) expect(assertKnowledgeWriteProtection(input)).toBeNull();
    expect(input).toEqual(before);
  });

  it("allows only trimmed empty content with allowEmpty", () => {
    const empty = Object.freeze({ newContent: " \n\t ", previousContent: previous100, allowEmpty: true });
    expect(detectKnowledgeWriteProtectionViolation(empty)).toBeNull();
    expect(assertKnowledgeWriteProtection(empty)).toBeNull();
    const marker = Object.freeze({ ...empty, newContent: " __probe " });
    expect(detectKnowledgeWriteProtectionViolation(marker)?.kind).toBe("probe_marker");
    expect(() => assertKnowledgeWriteProtection(marker)).toThrow(KnowledgeDomainError);
  });

  it.each([
    ["probe_marker", "__probe"],
    ["short_single_line", "x".repeat(19)],
    ["severe_truncation", "x".repeat(39)],
  ] as const)("rejects and explicitly overrides %s", (kind, newContent) => {
    const input = Object.freeze({ newContent, previousContent: previous200 });
    const before = { ...input };
    const violation = detectKnowledgeWriteProtectionViolation(input);
    expect(violation?.kind).toBe(kind);
    for (const override of [
      {},
      { force: true },
      { force: true, reason: "  \t" },
      { force: false, reason: "valid" },
      { reason: "valid" },
    ]) {
      const attempt = Object.freeze({ ...input, ...override });
      const snapshot = { ...attempt };
      try {
        assertKnowledgeWriteProtection(attempt);
        expect.fail("Expected a write protection rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(KnowledgeDomainError);
        expect(error).toMatchObject({ code: "write_protection_rejected", status: 422 });
      }
      expect(attempt).toEqual(snapshot);
    }
    const forced = Object.freeze({ ...input, force: true, reason: " deliberate rewrite " });
    const forcedBefore = { ...forced };
    expect(assertKnowledgeWriteProtection(forced)).toEqual(violation);
    expect(forced).toEqual(forcedBefore);
    expect(input).toEqual(before);
  });

  it("returns null for a normal write even with an override", () => {
    const input = Object.freeze({ newContent: "x".repeat(40), previousContent: previous200, force: true, reason: "valid" });
    const before = { ...input };
    expect(detectKnowledgeWriteProtectionViolation(input)).toBeNull();
    expect(assertKnowledgeWriteProtection(input)).toBeNull();
    expect(input).toEqual(before);
  });
});
