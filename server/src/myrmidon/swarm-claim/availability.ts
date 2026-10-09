// server/src/myrmidon/swarm-claim/availability.ts
//
// myrmidon(1.6.5 OPE-6608, ADM review of 18a69ff91): may the board wake this
// agent right now? (design §3.2 "свободный агент").
//
// The matcher pairs a task with an agent and only then wakes it. An agent the
// wake layer will refuse (a maintenance window, a budget that blocks its runs)
// must not enter the pool at all: otherwise the agent with the smallest id takes
// the top task of its caste on every pass, the wake answers 409, the pairing is
// rolled back, and the task starves while the trail fills with rollbacks.
//
// The invokability of the agent itself (status, the reporting chain) is decided
// by the vendor rule `evaluateAgentInvokability` on the pool read (matcher.ts);
// this module adds the two gates the wake layer applies on top of it, read the
// same way the wake layer reads them:
//   * the maintenance window (`isAgentUnderMaintenance`, myrmidon R3) — the gate
//     idle pickup asks too;
//   * the budget block (`budgetService.getInvocationBlock`) under the instance's
//     budget enforcement mode (`readBudgetEnforcement`), the reading
//     heartbeat.ts uses before it queues a wake.
// Neither read writes anything. A read that fails answers "available": the wake
// layer still refuses the wake, and the matcher then tries the next agent.

import type { Db } from "@paperclipai/db";
import { budgetService } from "../../services/budgets.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { readBudgetEnforcement } from "../budget-enforcement/settings.js";
import { isAgentUnderMaintenance } from "../maintenance/gate.js";

/** The port: true while a wake of the agent would not be refused by a gate. */
export type SwarmAgentAvailability = (input: { agentId: string; companyId: string }) => Promise<boolean>;

/** The default reading: the maintenance window and the budget block. */
export function swarmAgentAvailability(db: Db): SwarmAgentAvailability {
  const settings = instanceSettingsService(db);
  const budgets = budgetService(db, {
    resolveEnforcementMode: async () =>
      (await readBudgetEnforcement({ getGeneral: () => settings.getGeneral() })).mode,
  });
  return async ({ agentId, companyId }) => {
    try {
      if (await isAgentUnderMaintenance(db, agentId)) return false;
      const block = await budgets.getInvocationBlock(companyId, agentId);
      return !block;
    } catch {
      return true;
    }
  };
}
