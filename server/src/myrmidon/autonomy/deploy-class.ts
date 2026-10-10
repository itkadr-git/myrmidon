// myrmidon(1.6-AUTONOMY): the deploy action class on the deploy and maintenance
// routes. An agent caller is answered from the stored matrix before anything
// else; a board caller is not subject to the matrix and passes. `forbidden`
// answers 403 `autonomy_forbidden`; `approval_required` answers 403
// `autonomy_approval_required` (a plain board-API route has no held-action
// primitive yet, so the verdict denies instead of silently passing).

import type { Db } from "@paperclipai/db";
import type { Request } from "express";
import { forbidden } from "../../errors.js";
import { AUTONOMY_FORBIDDEN_CODE, dbAutonomyGate } from "./gate.js";

export const AUTONOMY_APPROVAL_REQUIRED_CODE = "autonomy_approval_required";

export async function assertDeployClassAllowed(db: Db, req: Request): Promise<void> {
  const decision = await dbAutonomyGate(db).decide(req, "deploy");
  if (decision.verdict === "forbidden") {
    throw forbidden("This action is forbidden for this role by the autonomy matrix", {
      code: AUTONOMY_FORBIDDEN_CODE,
      actionClass: "deploy",
      role: decision.role,
    });
  }
  if (decision.verdict === "approval_required") {
    throw forbidden("This action requires approval under the autonomy matrix", {
      code: AUTONOMY_APPROVAL_REQUIRED_CODE,
      actionClass: "deploy",
      role: decision.role,
    });
  }
}
