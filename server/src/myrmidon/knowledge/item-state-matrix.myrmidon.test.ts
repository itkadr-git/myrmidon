import { describe, expect, it } from "vitest";
import {
  assertItemTransition,
  canTransitionItem,
  KnowledgeDomainError,
  type KnowledgeItemStatus,
} from "./domain.js";

// Rows and columns follow the workflow contract, not the production edge list.
const statuses: readonly KnowledgeItemStatus[] = [
  "draft", "in_review", "published", "archived", "superseded",
];
const matrix: readonly (readonly boolean[])[] = [
  [false, true,  true,  true,  false],
  [true,  false, true,  true,  false],
  [false, false, false, true,  true ],
  [true,  true,  true,  false, true ],
  [false, false, false, false, false],
];

describe("knowledge item state matrix", () => {
  for (const [row, from] of statuses.entries()) {
    for (const [column, to] of statuses.entries()) {
      const allowed = matrix[row]![column]!;
      it(`${from} -> ${to}: ${allowed ? "allowed" : "refused"}`, () => {
        expect(canTransitionItem(from, to)).toBe(allowed);
        if (allowed) {
          expect(() => assertItemTransition(from, to)).not.toThrow();
        } else {
          let caught: unknown;
          try {
            assertItemTransition(from, to);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(KnowledgeDomainError);
          expect(caught).toMatchObject({ code: "invalid_status_transition", status: 409 });
        }
      });
    }
  }

  it("has positive and negative controls", () => {
    expect(canTransitionItem("archived", "published")).toBe(true);
    expect(() => assertItemTransition("archived", "published")).not.toThrow();
    expect(canTransitionItem("superseded", "draft")).toBe(false);
    expect(() => assertItemTransition("superseded", "draft")).toThrow(KnowledgeDomainError);
  });
});
