import { describe, expect, it } from "vitest";
import { assertRevisionTransition, KnowledgeDomainError, type KnowledgeRevisionStatus } from "./domain.js";

const allowed: readonly (readonly [KnowledgeRevisionStatus, KnowledgeRevisionStatus])[] = [
  ["draft", "submitted"],
  ["draft", "approved"],
  ["draft", "rejected"],
  ["submitted", "draft"],
  ["submitted", "approved"],
  ["submitted", "rejected"],
  ["rejected", "draft"],
];

const refused: readonly (readonly [KnowledgeRevisionStatus, KnowledgeRevisionStatus])[] = [
  ["draft", "draft"],
  ["submitted", "submitted"],
  ["approved", "draft"],
  ["approved", "submitted"],
  ["approved", "approved"],
  ["approved", "rejected"],
  ["rejected", "submitted"],
  ["rejected", "approved"],
  ["rejected", "rejected"],
];

describe("knowledge revision transition matrix", () => {
  it.each(allowed)("allows %s to %s", (from, to) => {
    expect(() => assertRevisionTransition(from, to)).not.toThrow();
  });

  it.each(refused)("refuses %s to %s with an exact domain error", (from, to) => {
    let caught: unknown;
    try {
      assertRevisionTransition(from, to);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KnowledgeDomainError);
    expect(caught).toMatchObject({
      code: "invalid_revision_transition",
      status: 409,
      message: `Revision cannot move from "${from}" to "${to}".`,
    });
  });
});
