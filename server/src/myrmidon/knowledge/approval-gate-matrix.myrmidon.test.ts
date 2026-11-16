import { describe, expect, it } from "vitest";
import {
  assertApprovable,
  KnowledgeDomainError,
  type KnowledgeApprover,
  type KnowledgeApprovalGateItem,
  type KnowledgeKind,
} from "./domain.js";

const kinds: readonly KnowledgeKind[] = ["note", "wiki", "answer", "task_outcome", "rule", "skill_card"];

function checkGate(item: KnowledgeApprovalGateItem, approver: KnowledgeApprover, code: string | null): void {
  const frozenItem = Object.freeze({ ...item });
  const frozenApprover = Object.freeze({ ...approver });
  if (code === null) {
    expect(() => assertApprovable(frozenItem, frozenApprover)).not.toThrow();
  } else {
    let caught: unknown;
    try {
      assertApprovable(frozenItem, frozenApprover);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KnowledgeDomainError);
    expect(caught).toMatchObject({ code, status: 403 });
  }
  expect(frozenItem).toEqual(item);
  expect(frozenApprover).toEqual(approver);
}

describe("knowledge approval gate matrix", () => {
  for (const kind of kinds) {
    it(`${kind}: missing required authority takes priority over mismatch`, () => {
      checkGate(
        { kind, approvalRequired: true, approverKind: null },
        { actorType: "user", actorId: "user-1", kind: "operator" },
        "rule_requires_approver_kind",
      );
    });

    it(`${kind}: missing required and presented authority still reports missing requirement`, () => {
      checkGate(
        { kind, approvalRequired: true, approverKind: null },
        { actorType: "agent", actorId: null, kind: null },
        "rule_requires_approver_kind",
      );
    });

    it(`${kind}: insufficient authority is refused`, () => {
      checkGate(
        { kind, approvalRequired: true, approverKind: "owner" },
        { actorType: "user", actorId: "user-1", kind: "operator" },
        "approver_kind_mismatch",
      );
    });

    it(`${kind}: matching authority passes`, () => {
      checkGate(
        { kind, approvalRequired: true, approverKind: "owner" },
        { actorType: "user", actorId: "user-1", kind: "owner" },
        null,
      );
    });

    it(`${kind}: no approval required passes without authority or actor identity`, () => {
      checkGate(
        { kind, approvalRequired: false, approverKind: null },
        { actorType: "agent", actorId: null, kind: null },
        null,
      );
    });
  }
});
