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

import type { Db } from "@myrmidon/db";
import { agents, heartbeatRuns } from "@myrmidon/db";
import { and, eq, gte, lt, notInArray, sql } from "drizzle-orm";
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
      if (block) return false;

      const [agent] = await db
        .select({ runtimeConfig: agents.runtimeConfig })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .limit(1);
      const runtimeConfig = agent?.runtimeConfig;
      const heartbeat =
        runtimeConfig && typeof runtimeConfig === "object" && !Array.isArray(runtimeConfig)
          ? (runtimeConfig as Record<string, unknown>).heartbeat
          : null;
      const heartbeatConfig =
        heartbeat && typeof heartbeat === "object" && !Array.isArray(heartbeat)
          ? (heartbeat as Record<string, unknown>)
          : null;
      const configuredLimit =
        heartbeatConfig?.maxDailyRuns ??
        heartbeatConfig?.dailyRunLimit ??
        heartbeatConfig?.dailyRunCap ??
        heartbeatConfig?.maxRunsPerDay;
      const dailyLimit =
        configuredLimit === null || configuredLimit === undefined || configuredLimit === ""
          ? null
          : Math.floor(Number(configuredLimit));
      if (dailyLimit !== null && Number.isFinite(dailyLimit) && dailyLimit >= 0) {
        const now = new Date();
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
        const [row] = await db
          .select({ total: sql<number>`count(*)::integer` })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(heartbeatRuns.agentId, agentId),
              gte(heartbeatRuns.startedAt, start),
              lt(heartbeatRuns.startedAt, end),
              notInArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
              sql`coalesce((${heartbeatRuns.resultJson}->>'failedBeforeModel') = 'true' or (${heartbeatRuns.resultJson}->>'failed_before_model') = 'true', false) = false`,
            ),
          );
        if (Number(row?.total ?? 0) >= dailyLimit) return false;
      }
      return true;
    } catch {
      return true;
    }
  };
}

/**
 * The port: true when the budget of the TASK's own scope (its project) blocks a
 * run on it — the reading the wake layer makes with the task's issue and
 * project. Such a task is skipped by the pass (no lease, no wake, no rollback)
 * and the agents stay free for the rest of the queue: the block belongs to the
 * task, not to the agent. A block of the agent or the company is the agent
 * gate's business (`swarmAgentAvailability`), not this one's.
 */
export type SwarmTaskBudgetBlock = (input: {
  companyId: string;
  agentId: string;
  issueId: string;
  projectId: string | null;
}) => Promise<boolean>;

/** The default reading of the task-scope budget block. */
export function swarmTaskBudgetBlock(db: Db): SwarmTaskBudgetBlock {
  const settings = instanceSettingsService(db);
  const budgets = budgetService(db, {
    resolveEnforcementMode: async () =>
      (await readBudgetEnforcement({ getGeneral: () => settings.getGeneral() })).mode,
  });
  return async ({ companyId, agentId, issueId, projectId }) => {
    if (!projectId) return false;
    try {
      const block = await budgets.getInvocationBlock(companyId, agentId, { issueId, projectId });
      return Boolean(block) && block!.scopeType !== "agent" && block!.scopeType !== "company";
    } catch {
      return false;
    }
  };
}
