// myrmidon(1.6-SKILL-LIFE): entry point.
//
// Wires the lifecycle service to the database and to the existing approvals
// pipeline, and hands app.ts a router. The bot profile compiler reads the same
// service's `resolveDelivery` through profile-ports.ts, so a candidate that is
// not in the pilot set, a deprecated skill and a rolled-back revision all take
// effect on the agents' next compile tick without a second code path.

import type { Db } from "@paperclipai/db";
import { approvalService, logActivity } from "../../services/index.js";
import { createSkillLifecycleService, type SkillLifecycleService } from "./service.js";
import { createDbSkillLifecycleStore } from "./store.js";
import { readCompanySkillPilotAgents, setCompanySkillPilotAgents } from "./pilot-agents-store.js";
import { SKILL_PROMOTION_APPROVAL_TYPE } from "./domain.js";
import { skillLifecycleRoutes } from "./routes.js";

export { SKILL_PILOT_AGENTS_ENV, SKILL_PROMOTION_APPROVAL_TYPE, SKILL_LIFECYCLE_STATES } from "./domain.js";
export type { SkillLifecycleState, SkillDeliveryState } from "./domain.js";
export type { SkillLifecycleService, SkillLifecycleView, SkillLifecycleDelivery, SkillLifecycleReadCache } from "./service.js";
export { createSkillLifecycleService } from "./service.js";
export { createDbSkillLifecycleStore } from "./store.js";
export {
  SKILL_PILOT_AGENTS_GENERAL_KEY,
  preserveSkillPilotAgentsGeneralKey,
  readSkillPilotAgentsByCompany,
} from "./pilot-agents-store.js";

/** The service bound to the database, with the audit row going to activity_log. */
export function skillLifecycleService(db: Db): SkillLifecycleService {
  return createSkillLifecycleService({
    store: createDbSkillLifecycleStore(db),
    logActivity: async (entry) => {
      await logActivity(db, entry);
    },
    // K-7: the pilot set is a board setting; env is the fallback (precedence
    // lives in domain.resolveSkillPilotAgents).
    readStoredPilotAgents: (companyId) => readCompanySkillPilotAgents(db, companyId),
    writeStoredPilotAgents: (companyId, agentIds) => setCompanySkillPilotAgents(db, companyId, agentIds),
  });
}

/** Router for app.ts: the skill lifecycle API under the company scope. */
export function myrmidonSkillLifecycleRoutes(db: Db) {
  const approvals = approvalService(db);
  return skillLifecycleRoutes({
    service: skillLifecycleService(db),
    async createPromotionApproval(input) {
      const approval = await approvals.create(input.companyId, {
        type: SKILL_PROMOTION_APPROVAL_TYPE,
        requestedByUserId: input.requestedByUserId,
        requestedByAgentId: input.requestedByAgentId,
        status: "pending",
        payload: {
          skillId: input.skillId,
          skillKey: input.skillKey,
          ...(input.note ? { note: input.note } : {}),
        },
      });
      return { approvalId: approval.id };
    },
  });
}