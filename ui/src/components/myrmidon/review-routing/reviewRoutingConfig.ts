// myrmidon(REVIEW-ROUTING): pure helpers of the review routing settings screen.
// No React, no network. The bounds mirror the server schema
// (packages/shared/src/myrmidon-review-routing.ts), which validates again.
//
// myrmidon(REVIEW-ROUTING PR-events UI): the prWatch bounds and defaults match
// the contract part A (server) adds to the schema — keep them byte-identical.

import type {
  ReviewRoutingPrStewardSettings,
  ReviewRoutingPrWatchSettings,
  ReviewRoutingSettings,
} from "./reviewRoutingApi";

export const REVIEW_ROUTING_MAX_LOAD_MIN = 1;
export const REVIEW_ROUTING_MAX_LOAD_MAX = 100;
export const REVIEW_ROUTING_REASSIGN_HOURS_MAX = 24 * 90;

// Bounds from the frozen prWatch contract (part A, reviewRoutingSettingsSchema).
export const PR_WATCH_MAX_OPEN_REVIEWS_MIN = 1;
export const PR_WATCH_MAX_OPEN_REVIEWS_MAX = 100;
export const PR_WATCH_MAX_NEW_ASSIGNMENTS_MIN = 1;
export const PR_WATCH_MAX_NEW_ASSIGNMENTS_MAX = 50;
export const PR_WATCH_POLL_INTERVAL_MIN = 15;
export const PR_WATCH_POLL_INTERVAL_MAX = 3600;
export const PR_STEWARD_MAX_MERGES_MIN = 1;
export const PR_STEWARD_MAX_MERGES_MAX = 50;

/** `owner/repo` entry: one slash, both halves non-empty, no spaces or refs. */
export const PR_REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** Role keys typed as a comma/space separated list; duplicates and blanks dropped. */
export function parseRoles(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((part) => part.trim()).filter((part) => part.length > 0))];
}

export function rolesToText(roles: readonly string[]): string {
  return roles.join(", ");
}

export type IntParse = { ok: true; value: number } | { ok: false };

/** A whole number in [min, max]; anything else is rejected. */
export function parseBoundedInt(text: string, min: number, max: number): IntParse {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  return value >= min && value <= max ? { ok: true, value } : { ok: false };
}

export interface ReviewRoutingDraft {
  enabled: boolean;
  roles: string;
  maxLoad: string;
  reassignHours: string;
  prWatchEnabled: boolean;
  /** `owner/repo` entries, one per line of the textarea; blanks are allowed (all repos). */
  prRepositories: string;
  prMaxOpenReviews: string;
  prMaxNewAssignments: string;
  prPollIntervalSec: string;
  stewardEnabled: boolean;
  stewardRoles: string;
  stewardMaxMerges: string;
}

/** prWatch with the schema defaults — used when the server predates part A. */
export function defaultPrWatchSettings(): ReviewRoutingPrWatchSettings {
  return {
    enabled: true,
    repositories: [],
    maxOpenReviewsPerReviewer: 3,
    maxNewAssignmentsPerPass: 5,
    pollIntervalSec: 60,
    steward: {
      enabled: true,
      roles: ["devops"],
      maxMergesPerSteward: 3,
    },
  };
}

export function draftFromSettings(settings: ReviewRoutingSettings): ReviewRoutingDraft {
  const prWatch = settings.prWatch ?? defaultPrWatchSettings();
  return {
    enabled: settings.enabled,
    roles: rolesToText(settings.reviewerRoles),
    maxLoad: String(settings.maxLoadPerReviewer),
    reassignHours: String(settings.reassignAfterHours),
    prWatchEnabled: prWatch.enabled,
    prRepositories: prWatch.repositories.join("\n"),
    prMaxOpenReviews: String(prWatch.maxOpenReviewsPerReviewer),
    prMaxNewAssignments: String(prWatch.maxNewAssignmentsPerPass),
    prPollIntervalSec: String(prWatch.pollIntervalSec),
    stewardEnabled: prWatch.steward.enabled,
    stewardRoles: rolesToText(prWatch.steward.roles),
    stewardMaxMerges: String(prWatch.steward.maxMergesPerSteward),
  };
}

/** Repository lines split into trimmed entries; duplicates and blanks dropped. */
export function parseRepositoryLines(text: string): string[] {
  return [...new Set(text.split(/\s*\n\s*/).map((line) => line.trim()).filter((line) => line.length > 0))];
}

/** True when every non-blank line is a well-formed `owner/repo` entry. */
export function repositoriesValid(text: string): boolean {
  return parseRepositoryLines(text).every((entry) => PR_REPOSITORY_PATTERN.test(entry));
}

/** The settings object a draft saves, or null while any field is invalid. */
export function settingsFromDraft(
  draft: ReviewRoutingDraft,
  base: ReviewRoutingSettings | null,
): ReviewRoutingSettings | null {
  const maxLoad = parseBoundedInt(draft.maxLoad, REVIEW_ROUTING_MAX_LOAD_MIN, REVIEW_ROUTING_MAX_LOAD_MAX);
  const hours = parseBoundedInt(draft.reassignHours, 0, REVIEW_ROUTING_REASSIGN_HOURS_MAX);
  const maxOpen = parseBoundedInt(
    draft.prMaxOpenReviews,
    PR_WATCH_MAX_OPEN_REVIEWS_MIN,
    PR_WATCH_MAX_OPEN_REVIEWS_MAX,
  );
  const maxNew = parseBoundedInt(
    draft.prMaxNewAssignments,
    PR_WATCH_MAX_NEW_ASSIGNMENTS_MIN,
    PR_WATCH_MAX_NEW_ASSIGNMENTS_MAX,
  );
  const poll = parseBoundedInt(draft.prPollIntervalSec, PR_WATCH_POLL_INTERVAL_MIN, PR_WATCH_POLL_INTERVAL_MAX);
  const maxMerges = parseBoundedInt(draft.stewardMaxMerges, PR_STEWARD_MAX_MERGES_MIN, PR_STEWARD_MAX_MERGES_MAX);
  if (!maxLoad.ok || !hours.ok || !maxOpen.ok || !maxNew.ok || !poll.ok || !maxMerges.ok) return null;
  if (!repositoriesValid(draft.prRepositories)) return null;

  const prWatch: ReviewRoutingPrWatchSettings = {
    enabled: draft.prWatchEnabled,
    repositories: parseRepositoryLines(draft.prRepositories),
    maxOpenReviewsPerReviewer: maxOpen.value,
    maxNewAssignmentsPerPass: maxNew.value,
    pollIntervalSec: poll.value,
    steward: {
      enabled: draft.stewardEnabled,
      roles: parseRoles(draft.stewardRoles),
      maxMergesPerSteward: maxMerges.value,
    },
  };

  // PUT has full-object semantics: copy the loaded settings and replace only
  // the fields this screen owns, so any pre-existing or future top-level key
  // survives the round-trip untouched.
  const basePrWatch: ReviewRoutingPrWatchSettings = base?.prWatch ?? defaultPrWatchSettings();
  return {
    ...(base ?? {}),
    enabled: draft.enabled,
    reviewerRoles: parseRoles(draft.roles),
    maxLoadPerReviewer: maxLoad.value,
    reassignAfterHours: hours.value,
    prWatch: { ...basePrWatch, ...prWatch },
  };
}
