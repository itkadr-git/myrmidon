// server/src/myrmidon/rule-grade.ts
//
// myrmidon(1.6.6 K-3): the ONE grade check for every route that writes a rule
// (approve, publish, rollback, archive, supersede, a roles change, ...). A new
// rule-writing route calls this function; nothing else compares grades.
//
// The grade the actor presents comes from its company membership
// (`approverKindFromRequest`, never from the request); the grade the rule needs
// is derived from its roles and the caste directory (`ruleApproverKind`).
// Passing two role sets (the old and the new one of a roles change) demands a
// grade covering both. No grade at all (`null`) is always a refusal.

import type { Request } from "express";
import { BUILTIN_SENSITIVE_CASTES } from "@myrmidon/shared";
import { forbidden } from "../errors.js";
import { approverKindFromRequest } from "./approver-kind.js";
import { approverKindSatisfies } from "./knowledge/domain.js";
import { ruleApproverKind, type CasteSensitivity } from "./knowledge/rules.js";

export type CasteSensitivityResolver = (companyId: string) => Promise<CasteSensitivity>;

/** Without a company directory (tests, no database) the built-in sensitive castes apply. */
export const builtinCasteSensitivity: CasteSensitivityResolver = async () => ({
  sensitive: new Set<string>(BUILTIN_SENSITIVE_CASTES),
});

export async function assertRuleWriteGrade(
  req: Request,
  companyId: string,
  sensitivityOf: CasteSensitivityResolver,
  ...roleSets: ReadonlyArray<readonly string[]>
): Promise<string> {
  const presented = approverKindFromRequest(req, companyId);
  const sensitivity = await sensitivityOf(companyId);
  for (const roles of roleSets) {
    const required = ruleApproverKind(roles, sensitivity);
    if (!approverKindSatisfies(required, presented)) {
      throw forbidden(`Writing this rule requires kind "${required}", the actor presents "${presented ?? "none"}"`, {
        code: "approver_kind_mismatch",
        required,
        presented,
      });
    }
  }
  if (presented === null) {
    throw forbidden("Writing a rule needs an operator, admin or owner membership of the company", {
      code: "approver_kind_mismatch",
      required: null,
      presented,
    });
  }
  return presented;
}
