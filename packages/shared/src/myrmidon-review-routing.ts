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
//
// 1.6.5 extends the same contract with the PR lane: the sweep also watches
// open pull requests and routes a review task the moment a PR head turns green
// without a review verdict, and a merge-steward task when the current head is
// approved. The `prWatch` block holds its settings; every field is additive —
// the pre-existing exports, fields, and defaults above stay byte-identical.

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

/** PR-watch defaults: the lane mirrors the board task it replaced, off only on request. */
export const DEFAULT_REVIEW_ROUTING_PR_WATCH_ENABLED = true;
export const DEFAULT_REVIEW_ROUTING_PR_REPOSITORIES: readonly string[] = [];
export const MAX_REVIEW_ROUTING_PR_REPOSITORIES = 20;
export const MAX_REVIEW_ROUTING_PR_REPOSITORY_LENGTH = 200;
/** A reviewer holding this many OPEN pr-review tasks is skipped by the PR lane. */
export const DEFAULT_REVIEW_ROUTING_PR_MAX_OPEN_REVIEWS_PER_REVIEWER = 3;
export const MAX_REVIEW_ROUTING_PR_MAX_OPEN_REVIEWS_PER_REVIEWER = 100;
/** Review/steward tasks the PR lane may create for one company per pass. */
export const DEFAULT_REVIEW_ROUTING_PR_MAX_NEW_ASSIGNMENTS_PER_PASS = 5;
export const MAX_REVIEW_ROUTING_PR_MAX_NEW_ASSIGNMENTS_PER_PASS = 50;
/** Seconds between GitHub repo polls of the PR lane (the task lane keeps its own tick). */
export const DEFAULT_REVIEW_ROUTING_PR_POLL_INTERVAL_SEC = 60;
export const MIN_REVIEW_ROUTING_PR_POLL_INTERVAL_SEC = 15;
export const MAX_REVIEW_ROUTING_PR_POLL_INTERVAL_SEC = 3600;
export const DEFAULT_REVIEW_ROUTING_PR_STEWARD_ENABLED = true;
/** Caste keys whose agents get merge-steward tasks. */
export const DEFAULT_REVIEW_ROUTING_PR_STEWARD_ROLES: readonly string[] = ["devops"];
/** Open merge tasks per steward before the PR lane skips them. */
export const DEFAULT_REVIEW_ROUTING_PR_MAX_MERGES_PER_STEWARD = 3;
export const MAX_REVIEW_ROUTING_PR_MAX_MERGES_PER_STEWARD = 50;

/** `owner/repo` shape, GitHub-lean: one slash, non-empty slug-safe segments. */
export const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isReviewRoutingRepositoryEntry(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_REVIEW_ROUTING_PR_REPOSITORY_LENGTH &&
    GITHUB_REPOSITORY_PATTERN.test(value)
  );
}

const reviewRoutingRepositoryListSchema = z
  .array(z.string().trim().min(1).max(MAX_REVIEW_ROUTING_PR_REPOSITORY_LENGTH).refine(isReviewRoutingRepositoryEntry, {
    message: "Expected an \"owner/repo\" GitHub repository entry",
  }))
  .max(MAX_REVIEW_ROUTING_PR_REPOSITORIES);

const reviewRoutingStewardSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_REVIEW_ROUTING_PR_STEWARD_ENABLED),
    roles: z.array(z.string().trim().min(1).max(64)).max(50).default([...DEFAULT_REVIEW_ROUTING_PR_STEWARD_ROLES]),
    maxMergesPerSteward: z
      .number()
      .int()
      .min(1)
      .max(MAX_REVIEW_ROUTING_PR_MAX_MERGES_PER_STEWARD)
      .default(DEFAULT_REVIEW_ROUTING_PR_MAX_MERGES_PER_STEWARD),
  })
  .strict();

export const reviewRoutingPrWatchSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_REVIEW_ROUTING_PR_WATCH_ENABLED),
    repositories: reviewRoutingRepositoryListSchema.default([...DEFAULT_REVIEW_ROUTING_PR_REPOSITORIES]),
    maxOpenReviewsPerReviewer: z
      .number()
      .int()
      .min(1)
      .max(MAX_REVIEW_ROUTING_PR_MAX_OPEN_REVIEWS_PER_REVIEWER)
      .default(DEFAULT_REVIEW_ROUTING_PR_MAX_OPEN_REVIEWS_PER_REVIEWER),
    maxNewAssignmentsPerPass: z
      .number()
      .int()
      .min(1)
      .max(MAX_REVIEW_ROUTING_PR_MAX_NEW_ASSIGNMENTS_PER_PASS)
      .default(DEFAULT_REVIEW_ROUTING_PR_MAX_NEW_ASSIGNMENTS_PER_PASS),
    pollIntervalSec: z
      .number()
      .int()
      .min(MIN_REVIEW_ROUTING_PR_POLL_INTERVAL_SEC)
      .max(MAX_REVIEW_ROUTING_PR_POLL_INTERVAL_SEC)
      .default(DEFAULT_REVIEW_ROUTING_PR_POLL_INTERVAL_SEC),
    steward: reviewRoutingStewardSchema.default({}),
  })
  .strict();

export type ReviewRoutingPrWatchSteward = z.infer<typeof reviewRoutingStewardSchema>;
export type ReviewRoutingPrWatch = z.infer<typeof reviewRoutingPrWatchSchema>;

/**
 * The PR-watch half of the settings: absent or malformed means the prWatch
 * defaults, and nothing from a bad value survives (it never blanks the
 * sibling keys — the outer object parses its own fields independently).
 */
export function normalizeReviewRoutingPrWatch(raw: unknown): ReviewRoutingPrWatch {
  const parsed = reviewRoutingPrWatchSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      ...parsed.data,
      repositories: [...new Set(parsed.data.repositories)],
      steward: { ...parsed.data.steward, roles: [...new Set(parsed.data.steward.roles)] },
    };
  }
  return reviewRoutingPrWatchSchema.parse({});
}

const reviewRoutingPrWatchField = z.preprocess(
  (value) => (value === undefined ? undefined : normalizeReviewRoutingPrWatch(value)),
  reviewRoutingPrWatchSchema.optional().default({}),
);

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
    prWatch: reviewRoutingPrWatchField,
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
/** The PR lane created a review task for a green, verdict-less PR head. */
export const REVIEW_ROUTING_PR_TASK_CREATED_ACTION = "issue.review_routing.pr_task_created";
/** The PR lane created a merge-steward task for an approved green PR head. */
export const REVIEW_ROUTING_STEWARD_TASK_CREATED_ACTION = "issue.review_routing.steward_task_created";

/** Work-product metadata keys the PR lane stamps on the task it creates. */
export const REVIEW_ROUTING_PR_HEAD_SHA_METADATA_KEY = "prRoutingHeadSha";
export const REVIEW_ROUTING_PR_KIND_METADATA_KEY = "prRoutingKind";
export type ReviewRoutingPrRoutingKind = "review" | "merge";
