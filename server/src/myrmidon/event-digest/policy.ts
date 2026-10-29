import type { EventPriority } from "./types.js";

/**
 * Event priority classification based on plan-166 §10 (OPE-9479 / OPE-9502):
 * - P0: Emergency / outage / security / fatal errors — immediately wakes agent.
 * - P1: CI/review completion, unanswered question, unblock, approvals — immediately wakes agent.
 * - P2: Assignment, actionable comments, children completed — wakes when actionable.
 * - P3: Busy / progress / info — accumulates in digest without waking.
 * - P4: Heartbeat / no-op / duplicate / debug logs — accumulates in digest without waking.
 */
export const EVENT_PRIORITY_BY_TYPE: Record<string, EventPriority> = {
  // P0: Emergency / Security / Outage
  security_incident: "P0",
  service_outage: "P0",
  system_failure: "P0",
  "budget.incident.opened": "P0",
  run_stalled: "P0",
  emergency: "P0",
  "native.recovery.transition": "P0",
  "native.local_process_stopped": "P0",
  "native.stopped_text_turn_verified": "P0",

  // P1: CI / Review / Unblock / Actionable completions
  ci_completed: "P1",
  review_completed: "P1",
  execution_review_requested: "P1",
  execution_approval_requested: "P1",
  issue_unblock_requested: "P1",
  issue_blockers_resolved: "P1",
  approval_approved: "P1",
  unanswered_question: "P1",
  "native.process_start_requested": "P1",
  "native.process_identity_recorded": "P1",
  lifecycle: "P1",

  // P2: Assignments & actionable comments
  issue_assigned: "P2",
  issue_commented: "P2",
  issue_children_completed: "P2",
  task_assigned: "P2",
  "run.startup.step": "P2",

  // P3: Progress / Timing / Activity metrics
  busy: "P3",
  progress: "P3",
  info: "P3",
  "run.phase.timing": "P3",
  output: "P3",
  "activity.logged": "P3",
  "cost_event.created": "P3",

  // P4: Heartbeats / No-ops / Duplicate / Logs
  heartbeat: "P4",
  heartbeat_timer: "P4",
  timer: "P4",
  noop: "P4",
  "no-op": "P4",
  duplicate: "P4",
  log: "P4",
};

/**
 * Classify the priority of an incoming event type or wake reason.
 * Defaults to "P4" if unknown to prevent spurious wakeups.
 */
export function classifyEventPriority(eventTypeOrReason: string): EventPriority {
  const normalized = (eventTypeOrReason ?? "").trim().toLowerCase();
  if (!normalized) return "P4";

  if (EVENT_PRIORITY_BY_TYPE[normalized]) {
    return EVENT_PRIORITY_BY_TYPE[normalized];
  }

  // Prefix matching for extensible event namespaces
  if (normalized.startsWith("security.") || normalized.startsWith("outage.")) {
    return "P0";
  }
  if (
    normalized.startsWith("ci.") ||
    normalized.startsWith("review.") ||
    normalized.startsWith("unblock.")
  ) {
    return "P1";
  }
  if (normalized.startsWith("progress.") || normalized.startsWith("metric.")) {
    return "P3";
  }
  if (normalized.startsWith("heartbeat.") || normalized.startsWith("log.")) {
    return "P4";
  }

  return "P4";
}

/**
 * P0 and P1 events trigger immediate agent wakeup.
 */
export function isImmediateWakePriority(priority: EventPriority): boolean {
  return priority === "P0" || priority === "P1";
}

/**
 * P3 and P4 events do not wake the agent; they accumulate in the event digest.
 */
export function isDigestAccumulatedPriority(priority: EventPriority): boolean {
  return priority === "P3" || priority === "P4";
}
