// server/src/myrmidon/bot-containers/fleet-audit-wiring.ts
//
// myrmidon(fleet-site audit): binds the fleet audit (fleet-audit.ts) to the activity log and to the
// bot cards. The three fleet wiring files wrap their router with it.

import { eq } from "drizzle-orm";
import { agents, type Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/index.js";
import type { FleetAuditDeps } from "./fleet-audit.js";

export function fleetAuditDeps(db: Db): FleetAuditDeps {
  return {
    logActivity: (input) => logActivity(db, input),
    botCompanyId: async (botKey) => {
      const rows = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, botKey)).limit(1);
      return rows[0]?.companyId ?? null;
    },
    log: logger,
  };
}
