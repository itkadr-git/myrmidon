// myrmidon(1.6.6 NOTIF-PREFS): per-agent notification preferences for
// event-shaped wakes. An agent's runtime config may carry a `notifications`
// block that mutes whole event classes — assignment wakes, comment mentions,
// review requests — so a wake is only generated when the target agent opted
// in. The block is read at wake-generation time in `heartbeat.ts`
// (enqueueWakeup), the single funnel every wake path goes through.
//
// Design rules:
// - Absence of any config means "notify": an agent without a `notifications`
//   block behaves exactly like before this feature, and unknown keys and
//   malformed values fall back to the per-event default (true). Only an
//   explicit boolean `false` mutes a class.
// - The three first-class classes map to wake *event types*, not raw reasons:
//   `assignment` (wake on issue assignment), `mention` (wake on a comment
//   that mentioned the agent), `review` (wake when the issue moved into
//   review awaiting the agent's decision, incl. changes-requested handoff).
//   Comments and other lifecycle events keep their own reasons but fold into
//   the closest class only where the class boundary is exact.

import { z } from "zod";

export const AGENT_NOTIFICATION_EVENTS = [
  "assignment",
  "mention",
  "review",
] as const;

export type AgentNotificationEvent = (typeof AGENT_NOTIFICATION_EVENTS)[number];

export const agentNotificationPrefsSchema = z
  .object({
    /** Master switch for the block. `false` mutes every class below. */
    enabled: z.boolean().optional().default(true),
    /** Wake when an issue is assigned (re)queued to this agent. */
    assignment: z.boolean().optional().default(true),
    /** Wake when an issue comment mentions this agent. */
    mention: z.boolean().optional().default(true),
    /** Wake when an execution review/approval is requested from this agent. */
    review: z.boolean().optional().default(true),
  })
  .strict();

export type AgentNotificationPrefs = z.infer<typeof agentNotificationPrefsSchema>;

/**
 * Normalize a raw `runtimeConfig.notifications` value field-by-field.
 * A missing, non-object, or malformed value yields the default (enabled) for
 * that field; sibling booleans are preserved. `z.optional().default({})` on a
 * parent object does NOT fill nested defaults in zod v4, so normalization is
 * explicit here.
 */
export function normalizeAgentNotificationPrefs(raw: unknown): AgentNotificationPrefs {
  const parsed = agentNotificationPrefsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Fall back to per-field defaults: a malformed block must never crash a
  // wake path or silently mute everything.
  const obj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const pick = (key: "enabled" | AgentNotificationEvent): boolean =>
    typeof obj[key] === "boolean" ? obj[key] : true;
  return {
    enabled: pick("enabled"),
    assignment: pick("assignment"),
    mention: pick("mention"),
    review: pick("review"),
  };
}

/** Read the notification prefs from a full agent runtimeConfig record. */
export function readAgentNotificationPrefs(
  runtimeConfig: unknown,
): AgentNotificationPrefs {
  const cfg =
    typeof runtimeConfig === "object" && runtimeConfig !== null
      ? (runtimeConfig as Record<string, unknown>)
      : {};
  return normalizeAgentNotificationPrefs(cfg.notifications);
}

/**
 * Wake reasons that mean "an issue was assigned to the agent" — the
 * assignment class. Recovery/reconciliation wakes that re-deliver the same
 * assignment event belong here too; operator/manual wakes do not (they are
 * not a notification class).
 */
const ASSIGNMENT_CLASS_REASONS: ReadonlySet<string> = new Set([
  "issue_assigned",
  "issue_assignment_recovery",
]);

/**
 * Wake reasons in the mention class: a comment that @-mentioned the agent.
 * Plain comment wakes (`issue_commented`) are direct instructions to the
 * assignee/responsible user, not mentions, and stay outside the class.
 */
const MENTION_CLASS_REASONS: ReadonlySet<string> = new Set([
  "issue_comment_mentioned",
]);

/**
 * Wake reasons in the review class: the board asks this agent to render a
 * review/approval decision on an issue, or sends the issue back after
 * changes were requested from the reviewer side.
 */
const REVIEW_CLASS_REASONS: ReadonlySet<string> = new Set([
  "execution_review_requested",
  "execution_approval_requested",
  "execution_changes_requested",
]);

export type AgentNotificationClass = AgentNotificationEvent;

/**
 * Map a wake reason to its notification class. Returns null when the reason
 * belongs to no configurable class (comment delivery, blockers resolved,
 * monitors, timers, manual wakes, …) — those always pass the filter.
 */
export function classifyNotificationWakeReason(
  reason: string | null | undefined,
): AgentNotificationClass | null {
  if (!reason) return null;
  if (ASSIGNMENT_CLASS_REASONS.has(reason)) return "assignment";
  if (MENTION_CLASS_REASONS.has(reason)) return "mention";
  if (REVIEW_CLASS_REASONS.has(reason)) return "review";
  return null;
}

/**
 * The single decision point used by every wake-generation path: should the
 * event-shaped wake with this reason be delivered to an agent with this
 * runtimeConfig? True means deliver (no class, block absent, or class
 * enabled); false means the agent muted the class.
 */
export function notificationWakeAllowed(
  runtimeConfig: unknown,
  reason: string | null | undefined,
): boolean {
  const cls = classifyNotificationWakeReason(reason);
  if (!cls) return true;
  const prefs = readAgentNotificationPrefs(runtimeConfig);
  if (!prefs.enabled) return false;
  return prefs[cls];
}
