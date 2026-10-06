// myrmidon(1.6-AUTONOMY): the real side effects for a replayed held action.
//
// Kept apart from `action-execution.ts` on purpose: this is the only part that
// needs the agent and heartbeat services, while the exactly-once rule lives in
// the service-free module next to it. The review path (`tool-action-review.ts`)
// builds the executors here and hands them to `executeApprovedAutonomyAction`.

import type { Db } from "@paperclipai/db";
import { agentService } from "../../services/agents.js";
import { heartbeatService } from "../../services/heartbeat.js";
import type { AutonomyActionExecutorsFactory } from "./action-execution.js";

/**
 * Pause / resume / wake an agent for real. The wake is requested as the actor
 * whose action was held, and carries the approval in `contextSnapshot` so the
 * run log shows why the action ran after a hold.
 */
export function autonomyActionExecutors(db: Db): AutonomyActionExecutorsFactory {
  const agents = agentService(db);
  // Built on first use: a pause/resume replay never needs the heartbeat
  // service, and constructing it eagerly would make every approval pay for it.
  let heartbeat: ReturnType<typeof heartbeatService> | null = null;
  return (origin) => ({
    pause: (agentId) => agents.pause(agentId),
    resume: (agentId) => agents.resume(agentId),
    wakeup: (agentId) => {
      heartbeat ??= heartbeatService(db);
      return heartbeat.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "Approved autonomy action",
        requestedByActorType: origin.actorType === "agent" ? "agent" : "user",
        requestedByActorId: origin.actorId,
        contextSnapshot: { autonomyAction: true, approved: true },
      });
    },
  });
}