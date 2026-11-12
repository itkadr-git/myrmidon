import { activityLog } from "@myrmidon/db";
import type { Db } from "@myrmidon/db";
import { appendHeartbeatRunEvent } from "../../../services/heartbeat-run-events.js";
import type { RunEventSink } from "../application/event-sink.js";
import type { RunLifecycleEventCommand } from "../domain/run-event-command.js";

/**
 * Postgres implementation of the run-dispatch event sink (OPE-12797,
 * ORCH-IO-SPLIT). Commits an already-decided lifecycle event — and, when
 * present, its activity-log receipt — in the caller's open transaction.
 */
export function createPostgresRunEventSink(): RunEventSink {
  return {
    async commitRunEvent(tx: Db, command: RunLifecycleEventCommand): Promise<void> {
      await appendHeartbeatRunEvent(tx, {
        companyId: command.run.companyId,
        runId: command.run.runId,
        agentId: command.run.agentId,
        eventType: "lifecycle",
        stream: "system",
        level: command.level,
        message: command.message,
        payload: command.payload,
      });

      if (command.activityReceipt) {
        await tx.insert(activityLog).values({
          companyId: command.run.companyId,
          actorType: "system",
          actorId: command.activityReceipt.actorId,
          action: command.activityReceipt.action,
          entityType: command.activityReceipt.entityType,
          entityId: command.activityReceipt.entityId,
          agentId: command.run.agentId,
          runId: command.run.runId,
          details: command.activityReceipt.details,
        });
      }
    },
  };
}
