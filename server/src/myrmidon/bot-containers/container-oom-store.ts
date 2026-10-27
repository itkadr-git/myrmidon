// myrmidon(OPE-9253): durable OOM observations, independent of recovery factory.
import { and, eq, gte, lte, or, isNull, desc, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, type Db } from "@myrmidon/db";
import type { ContainerOomObservation } from "./container-oom.js";

/** One activity row per observed container/finish pair, even across board restarts.
 * Never changes run status or applies limits; the factory consumes this evidence later.
 */
export function containerOomRecorder(db: Db) {
  return async (agentId: string, observation: ContainerOomObservation): Promise<void> => {
    const occurredAt = new Date(observation.occurredAt);
    const eventKey = `${observation.containerId}:${observation.occurredAt}`;
    await db.transaction(async (tx) => {
      // Serialize only this event, including concurrent readers in another board process.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`container-oom:${agentId}:${eventKey}`}, 0))`);
      const [agent] = await tx.select({ companyId: agents.companyId, role: agents.role })
        .from(agents).where(eq(agents.id, agentId)).limit(1);
      if (!agent) return;
      const [existing] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, agent.companyId), eq(activityLog.agentId, agentId),
        eq(activityLog.action, "agent.container_oom"), eq(activityLog.entityId, eventKey),
      )).limit(1);
      if (existing) return;
      // Correlate by event time, NOT whichever run happens to be current at poll time.
      const candidates = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agentId),
        lte(heartbeatRuns.startedAt, occurredAt),
        or(isNull(heartbeatRuns.finishedAt), gte(heartbeatRuns.finishedAt, occurredAt)),
      )).orderBy(desc(heartbeatRuns.startedAt)).limit(2);
      const runId = candidates.length === 1 ? candidates[0].id : null;
      await tx.insert(activityLog).values({
        companyId: agent.companyId, actorType: "system", actorId: "myrmidon-container-oom",
        agentId, runId, action: "agent.container_oom", entityType: "container_oom", entityId: eventKey,
        details: {
          kind: "resource.oom", source: "docker.inspect", ...observation, role: agent.role,
          correlation: runId ? "event_time" : candidates.length > 1 ? "ambiguous" : "unmatched",
          // This is a configured limit, not a measured peak. Do not invent a peak/command.
          peakMemoryBytes: null,
        },
      });
    });
  };
}
