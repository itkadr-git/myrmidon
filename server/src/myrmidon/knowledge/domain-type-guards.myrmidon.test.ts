import { describe, expect, it } from "vitest";
import { isKnowledgeItemStatus, isKnowledgeKind, isKnowledgeRevisionStatus } from "./domain.js";

const kinds = ["note", "wiki", "answer", "task_outcome", "rule", "skill_card"];
const itemStatuses = ["draft", "in_review", "published", "archived", "superseded"];
const revisionStatuses = ["draft", "submitted", "approved", "rejected"];

const invalidValues: unknown[] = [
  null, undefined, true, false, 0, 1, [], {}, "", "unknown", "DRAFT", " draft", "draft ",
  "NOTE", " note", "note ", "APPROVED", " approved", "approved ",
];

describe("knowledge domain type guards", () => {
  it("accepts only knowledge kinds", () => {
    for (const value of kinds) expect(isKnowledgeKind(value), value).toBe(true);
    for (const value of [...itemStatuses, ...revisionStatuses, ...invalidValues]) {
      expect(isKnowledgeKind(value)).toBe(false);
    }
  });

  it("accepts item statuses but not kinds or revision-only statuses", () => {
    for (const value of itemStatuses) expect(isKnowledgeItemStatus(value), value).toBe(true);
    for (const value of [...kinds, "submitted", "approved", "rejected", ...invalidValues]) {
      expect(isKnowledgeItemStatus(value)).toBe(false);
    }
  });

  it("accepts revision statuses but not kinds or item-only statuses", () => {
    for (const value of revisionStatuses) expect(isKnowledgeRevisionStatus(value), value).toBe(true);
    for (const value of [...kinds, "in_review", "published", "archived", "superseded", ...invalidValues]) {
      expect(isKnowledgeRevisionStatus(value)).toBe(false);
    }
  });
});
