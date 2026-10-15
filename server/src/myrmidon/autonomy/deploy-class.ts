// myrmidon(1.6-AUTONOMY): the deploy action class on the deploy and maintenance
// routes. An agent caller is answered from the stored matrix before anything
// else; a board caller is not subject to the matrix and passes. `forbidden`
// answers 403 `autonomy_forbidden`; `approval_required` answers 403
// `autonomy_approval_required` (a plain board-API route has no held-action
// primitive yet, so the verdict denies instead of silently passing).
//
// The verdict-to-response mapping lives in `gate.ts` (`assertAllowed`) and is
// reused here: rel already carries the approval-required half there for the
// pause/wake routes, so the deploy seam must not keep a second copy of it.

import type { Db } from "@paperclipai/db";
import type { Request } from "express";
import { dbAutonomyGate } from "./gate.js";

export async function assertDeployClassAllowed(db: Db, req: Request): Promise<void> {
  await dbAutonomyGate(db).assertAllowed(req, "deploy");
}