// packages/shared/src/myrmidon-review-routing.ts
//
// myrmidon(REVIEW-ROUTING): the shared contract of automatic reviewer routing.
//
// A task that moves to `in_review` with no reviewer participant used to sit
// there until an operator assigned someone by hand. The board now does it: a
// periodic sweep gives such a task a review stage with one reviewer chosen
// from the reviewer castes (`agents.role`) by least load, never the task's
// author or assignee. When no reviewer is available the sweep raises an
// attention signal instead of staying silent, and a review that has no verdict
// after `reassignAfterHours` gets a signal and is moved to another reviewer.
//
// The settings live in `instance_settings.general.reviewRouting` and are read
// on every sweep pass, so a change applies without a restart.

import { z } from "zod";

/** The `instance_settings.general` key this feature stores its settings under. */
export const REVIEW_ROUTING_SETTINGS_KEY = "reviewRouting";

export const DEFAULT_REVIEW_ROUTING_ENABLED = true;
/** Caste keys (`agents.role`) whose agents may be picked as reviewers. */
export const DEFAULT_REVIEW_ROUTING_REVIEWER_ROLES: readonly string[] = ["reviewer"];
/** A reviewer already holding this many tasks in flight is not picked. */
export const DEFAULT_REVIEW_ROUTING_MAX_LOAD_PER_REVIEWER = 5;
export const MAX_REVIEW_ROUTING_MAX_LOAD_PER_REVIEWER = 100;
/** Hours without a verdict before the review is signalled and reassigned; 0 = never. */
export const DEFAULT_REVIEW_ROUTING_REASSIGN_AFTER_HOURS = 24;
export const MAX_REVIEW_ROUTING_REASSIGN_AFTER_HOURS = 24 * 90;

export const reviewRoutingSettingsSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_REVIEW_ROUTING_ENABLED),
    reviewerRoles: z
      .array(z.string().trim().min(1).max(64))
      .max(50)
      .default([...DEFAULT_REVIEW_ROUTING_REVIEWER_ROLES]),
    maxLoadPerReviewer: z
      .number()
      .int()
      .min(1)
      .max(MAX_REVIEW_ROUTING_MAX_LOAD_PER_REVIEWER)
      .default(DEFAULT_REVIEW_ROUTING_MAX_LOAD_PER_REVIEWER),
    reassignAfterHours: z
      .number()
      .int()
      .min(0)
      .max(MAX_REVIEW_ROUTING_REASSIGN_AFTER_HOURS)
      .default(DEFAULT_REVIEW_ROUTING_REASSIGN_AFTER_HOURS),
  })
  .strict();

export type ReviewRoutingSettings = z.infer<typeof reviewRoutingSettingsSchema>;

/** The stored settings, or the defaults when absent or unreadable. */
export function normalizeReviewRoutingSettings(raw: unknown): ReviewRoutingSettings {
  const parsed = reviewRoutingSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return { ...parsed.data, reviewerRoles: [...new Set(parsed.data.reviewerRoles)] };
  }
  // A hand-edited row cannot half-apply: unreadable means the defaults.
  return reviewRoutingSettingsSchema.parse({});
}

/** Activity actions the routing writes (one per event, on the issue). */
export const REVIEW_ROUTING_ASSIGNED_ACTION = "issue.review_routing.assigned";
export const REVIEW_ROUTING_REASSIGNED_ACTION = "issue.review_routing.reassigned";
