import { describe, expect, it } from "vitest";
import { KnowledgeDomainError, planRollback, type KnowledgeRevisionStatus } from "./domain.js";

describe("rollback plan contract (S5)", () => {
  const refusals: Array<{
    name: string;
    revisionId: string;
    status: KnowledgeRevisionStatus;
    deliveredRevisionId: string | null;
    code: string;
    httpStatus: number;
  }> = [
    { name: "empty target", revisionId: "", status: "approved", deliveredRevisionId: null, code: "rollback_no_target", httpStatus: 400 },
    { name: "empty target precedes unapproved and matching delivered", revisionId: "", status: "draft", deliveredRevisionId: "", code: "rollback_no_target", httpStatus: 400 },
    ...(["draft", "submitted", "rejected"] as const).flatMap((status) => [
      { name: `${status} target`, revisionId: "target", status, deliveredRevisionId: "other", code: "rollback_target_not_approved", httpStatus: 409 },
      { name: `${status} target precedes matching delivered`, revisionId: "target", status, deliveredRevisionId: "target", code: "rollback_target_not_approved", httpStatus: 409 },
    ]),
    { name: "approved target already delivered", revisionId: "target", status: "approved", deliveredRevisionId: "target", code: "rollback_noop", httpStatus: 409 },
  ];

  it.each(refusals)("refuses $name with exact domain error", ({ revisionId, status, deliveredRevisionId, code, httpStatus }) => {
    const item = Object.freeze({ deliveredRevisionId, currentRevisionNumber: 4 });
    const target = Object.freeze({ revisionId, revisionNumber: 1, status });
    let caught: unknown;
    try {
      planRollback(item, target);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KnowledgeDomainError);
    expect(caught).toMatchObject({ code, status: httpStatus });
    expect(item).toEqual({ deliveredRevisionId, currentRevisionNumber: 4 });
    expect(target).toEqual({ revisionId, revisionNumber: 1, status });
  });

  it.each([null, "delivered"])('appends a fresh plan with deliveredRevisionId=%s', (deliveredRevisionId) => {
    for (const currentRevisionNumber of [1, 4, 100]) {
      for (const revisionNumber of new Set([0, currentRevisionNumber - 1])) {
        const item = Object.freeze({ deliveredRevisionId, currentRevisionNumber });
        const target = Object.freeze({ revisionId: "target", revisionNumber, status: "approved" as const });
        const expected = { newRevisionNumber: currentRevisionNumber + 1, rolledBackFromRevisionId: "target" };
        const first = planRollback(item, target);
        const second = planRollback(item, target);
        expect(first).toEqual(expected);
        expect(second).toEqual(expected);
        expect(second).not.toBe(first);
        expect(item).toEqual({ deliveredRevisionId, currentRevisionNumber });
        expect(target).toEqual({ revisionId: "target", revisionNumber, status: "approved" });
      }
    }
  });
});
