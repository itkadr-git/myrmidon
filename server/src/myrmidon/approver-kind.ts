// server/src/myrmidon/approver-kind.ts
//
// myrmidon(1.6.6 K-3): the grade a board actor presents to the rule approval
// gate. One definition for every route that approves, restores or rolls back a
// rule (knowledge, autonomy, wiki-cortex), so a grade is never taken from a
// request body and never computed in two places.

import type { Request } from "express";

/**
 * The instance admin and the local implicit board are the owner; a company
 * membership maps by its role (owner, admin, otherwise operator).
 * Never taken from the request body: the caller cannot type its own grade.
 *
 * `null` = no grade: a viewer, an unknown role, no active membership of the
 * company. Every caller treats `null` as a refusal.
 */
export function approverKindFromRequest(req: Request, companyId: string): string | null {
  const actor = (req.actor ?? {}) as {
    source?: string;
    isInstanceAdmin?: boolean;
    memberships?: Array<{ companyId: string; status?: string; membershipRole?: string | null }>;
  };
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return "owner";
  const membership = actor.memberships?.find((m) => m.companyId === companyId && m.status === "active");
  if (membership?.membershipRole === "owner") return "owner";
  if (membership?.membershipRole === "admin") return "admin";
  if (membership?.membershipRole === "operator" || membership?.membershipRole === "member") return "operator";
  return null;
}
