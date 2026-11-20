import { describe, expect, it } from "vitest";
import { assertRuleFields, KnowledgeDomainError } from "./domain.js";

describe("knowledge rule field invariants", () => {
  it.each([
    [false, null, "rule_requires_approval"],
    [false, "", "rule_requires_approval"],
    [false, "operator", "rule_requires_approval"],
    [false, "owner", "rule_requires_approval"],
    [false, "custom", "rule_requires_approval"],
    [true, null, "rule_requires_approver_kind"],
    [true, "", "rule_requires_approver_kind"],
  ] as const)("rejects rule approval=%s approver=%s with %s", (approvalRequired, approverKind, code) => {
    let caught: unknown;
    try {
      assertRuleFields("rule", approvalRequired, approverKind);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KnowledgeDomainError);
    expect(caught).toMatchObject({ code, status: 400 });
  });

  it.each(["operator", "owner", "custom"])("accepts an approval-required rule with approver %s", (approverKind) => {
    expect(() => assertRuleFields("rule", true, approverKind)).not.toThrow();
  });

  it.each(["note", "wiki", "answer", "task_outcome", "skill_card"] as const)(
    "does not impose rule fields on %s",
    (kind) => {
      for (const approvalRequired of [false, true]) {
        for (const approverKind of [null, "", "operator", "owner", "custom"]) {
          expect(() => assertRuleFields(kind, approvalRequired, approverKind)).not.toThrow();
        }
      }
    },
  );
});
