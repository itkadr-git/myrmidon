/** Priority labels for buffered events, ordered from urgent to informational. */
export type EventPriority = "P0" | "P1" | "P2" | "P3" | "P4";

/** Canonical event-type mapping; unlisted extension events remain lowest priority. */
export const EVENT_PRIORITY_BY_TYPE: Readonly<Record<string, EventPriority>> = {
  "native.recovery.transition": "P0",
  "native.local_process_stopped": "P0",
  "native.stopped_text_turn_verified": "P0",
  "native.process_start_requested": "P1",
  "native.process_identity_recorded": "P1",
  lifecycle: "P1",
  "run.startup.step": "P2",
  "run.phase.timing": "P3",
  output: "P3",
  log: "P4",
};

export function classifyEventPriority(eventType: string): EventPriority {
  return EVENT_PRIORITY_BY_TYPE[eventType] ?? "P4";
}
