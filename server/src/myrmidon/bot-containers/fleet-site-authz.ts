// server/src/myrmidon/bot-containers/fleet-site-authz.ts
//
// myrmidon(1.6.7 FLEET-SITE-ENROLL): who may register, change or remove an execution site.
// A site is where the board sends a bearer token and a client certificate, and where it issues a
// server key, so only the company owner may do it. A plain company admin may not.
// The instance-wide board identity (local implicit access or an instance admin) keeps full control,
// the same rule as the fleet console (assertFleetConsoleOwner).

import type { Request } from "express";
import { forbidden } from "../../errors.js";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";

export function assertFleetSiteOwner(req: Request, companyId: string): void {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  assertCompanyAccess(req, companyId);
  const membership = req.actor.memberships?.find((m) => m.companyId === companyId && m.status === "active");
  if (membership?.membershipRole === "owner") return;
  throw forbidden("Company owner access required");
}
