import type { Db } from "@myrmidon/db";
import type { RunLifecycleEventCommand } from "../domain/run-event-command.js";

/**
 * Event sink of the run-dispatch module (OPE-12797, ORCH-IO-SPLIT): the only
 * place that commits a decided run event. It accepts an already-decided
 * command (level, message, payload, optional activity receipt) and makes it
 * durable in the CALLER's transaction — the same pattern as the
 * interaction-continuation outbox, whose intent is written inside the card
 * resolution transaction. Decision code never touches the database; the sink
 * never makes decisions.
 */
export interface RunEventSink {
  commitRunEvent(tx: Db, command: RunLifecycleEventCommand): Promise<void>;
}
