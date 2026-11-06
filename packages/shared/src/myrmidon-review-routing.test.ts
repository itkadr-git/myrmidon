import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_ROUTING_BOARD_MERGE_MAX_PER_PASS,
  DEFAULT_REVIEW_ROUTING_MAX_LOAD_PER_REVIEWER,
  DEFAULT_REVIEW_ROUTING_PR_MAX_MERGES_PER_STEWARD,
  DEFAULT_REVIEW_ROUTING_PR_MAX_NEW_ASSIGNMENTS_PER_PASS,
  DEFAULT_REVIEW_ROUTING_PR_MAX_OPEN_REVIEWS_PER_REVIEWER,
  DEFAULT_REVIEW_ROUTING_PR_POLL_INTERVAL_SEC,
  DEFAULT_REVIEW_ROUTING_REASSIGN_AFTER_HOURS,
  isReviewRoutingRepositoryEntry,
  normalizeReviewRoutingBoardMerge,
  normalizeReviewRoutingPrWatch,
  normalizeReviewRoutingSettings,
  reviewRoutingBoardMergeSchema,
  reviewRoutingPrWatchSchema,
  reviewRoutingSettingsSchema,
} from "./myrmidon-review-routing.js";
import type { InstanceGeneralSettings } from "./types/instance.js";
import { instanceGeneralSettingsSchema } from "./validators/instance.js";

const PR_WATCH_DEFAULTS = {
  enabled: true,
  repositories: [],
  maxOpenReviewsPerReviewer: DEFAULT_REVIEW_ROUTING_PR_MAX_OPEN_REVIEWS_PER_REVIEWER,
  maxNewAssignmentsPerPass: DEFAULT_REVIEW_ROUTING_PR_MAX_NEW_ASSIGNMENTS_PER_PASS,
  pollIntervalSec: DEFAULT_REVIEW_ROUTING_PR_POLL_INTERVAL_SEC,
  steward: {
    enabled: true,
    roles: ["devops"],
    maxMergesPerSteward: DEFAULT_REVIEW_ROUTING_PR_MAX_MERGES_PER_STEWARD,
  },
};

const BOARD_MERGE_DEFAULTS = {
  enabled: true,
  method: "squash",
  baseBranches: ["main"],
  requiredChecks: ["CI result"],
  repositories: [],
  maxMergesPerPass: DEFAULT_REVIEW_ROUTING_BOARD_MERGE_MAX_PER_PASS,
};

describe("myrmidon(REVIEW-ROUTING) settings contract", () => {
  it("falls back to the defaults for an absent or unreadable row", () => {
    for (const raw of [undefined, null, "x", { maxLoadPerReviewer: 0 }, { unknown: 1 }]) {
      expect(normalizeReviewRoutingSettings(raw)).toEqual({
        enabled: true,
        reviewerRoles: ["reviewer", "lead"],
        maxLoadPerReviewer: DEFAULT_REVIEW_ROUTING_MAX_LOAD_PER_REVIEWER,
        queueThreshold: 8,
        reassignAfterHours: DEFAULT_REVIEW_ROUTING_REASSIGN_AFTER_HOURS,
        prWatch: PR_WATCH_DEFAULTS,
        boardMerge: BOARD_MERGE_DEFAULTS,
      });
    }
  });

  it("keeps a stored value, fills missing fields and drops duplicate roles", () => {
    expect(
      normalizeReviewRoutingSettings({ reviewerRoles: ["qa", "qa", "lead"], reassignAfterHours: 0 }),
    ).toEqual({
      enabled: true,
      reviewerRoles: ["qa", "lead"],
      maxLoadPerReviewer: DEFAULT_REVIEW_ROUTING_MAX_LOAD_PER_REVIEWER,
      queueThreshold: 8,
      reassignAfterHours: 0,
      prWatch: PR_WATCH_DEFAULTS,
      boardMerge: BOARD_MERGE_DEFAULTS,
    });
  });

  it("rejects out-of-range values and unknown keys", () => {
    expect(reviewRoutingSettingsSchema.safeParse({ maxLoadPerReviewer: 0 }).success).toBe(false);
    expect(reviewRoutingSettingsSchema.safeParse({ maxLoadPerReviewer: 101 }).success).toBe(false);
    expect(reviewRoutingSettingsSchema.safeParse({ reassignAfterHours: -1 }).success).toBe(false);
    expect(reviewRoutingSettingsSchema.safeParse({ reassignAfterMinutes: -1 }).success).toBe(false);
    expect(reviewRoutingSettingsSchema.safeParse({ reassignAfterMinutes: 30 }).success).toBe(true);
    expect(reviewRoutingSettingsSchema.safeParse({ reviewerRoles: [""] }).success).toBe(false);
    expect(reviewRoutingSettingsSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("prWatch: absent means the documented defaults", () => {
    expect(normalizeReviewRoutingSettings({}).prWatch).toEqual(PR_WATCH_DEFAULTS);
    expect(normalizeReviewRoutingPrWatch(undefined)).toEqual(PR_WATCH_DEFAULTS);
    expect(normalizeReviewRoutingPrWatch({ enabled: false })).toEqual({ ...PR_WATCH_DEFAULTS, enabled: false });
  });

  it("prWatch: a malformed block falls back to prWatch defaults and never blanks the siblings", () => {
    for (const malformed of [
      "x",
      [],
      { repositories: "owner/repo" },
      { repositories: ["not a repo"] },
      { maxOpenReviewsPerReviewer: 0 },
      { maxOpenReviewsPerReviewer: 101 },
      { maxNewAssignmentsPerPass: 0 },
      { maxNewAssignmentsPerPass: 51 },
      { pollIntervalSec: 14 },
      { pollIntervalSec: 3601 },
      { steward: { enabled: "yes" } },
      { steward: { maxMergesPerSteward: 0 } },
      { unknown: true },
    ]) {
      expect(normalizeReviewRoutingSettings({ reviewerRoles: ["qa"], prWatch: malformed })).toEqual({
        enabled: true,
        reviewerRoles: ["qa"],
        maxLoadPerReviewer: DEFAULT_REVIEW_ROUTING_MAX_LOAD_PER_REVIEWER,
        queueThreshold: 8,
        reassignAfterHours: DEFAULT_REVIEW_ROUTING_REASSIGN_AFTER_HOURS,
        prWatch: PR_WATCH_DEFAULTS,
        boardMerge: BOARD_MERGE_DEFAULTS,
      });
    }
  });

  it("prWatch: a malformed nested steward falls back only to the steward defaults", () => {
    expect(
      normalizeReviewRoutingPrWatch({ pollIntervalSec: 120, steward: { roles: "devops" } }),
    ).toEqual({ ...PR_WATCH_DEFAULTS, pollIntervalSec: 120, steward: PR_WATCH_DEFAULTS.steward });
  });

  it("prWatch: repository entries validate as owner/repo and duplicates drop", () => {
    expect(isReviewRoutingRepositoryEntry("acme/widgets")).toBe(true);
    expect(isReviewRoutingRepositoryEntry("acme/widgets.core")).toBe(true);
    expect(isReviewRoutingRepositoryEntry("acme")).toBe(false);
    expect(isReviewRoutingRepositoryEntry("acme/widgets/extra")).toBe(false);
    expect(isReviewRoutingRepositoryEntry("acme/")).toBe(false);
    expect(isReviewRoutingRepositoryEntry("acme widgets")).toBe(false);
    expect(isReviewRoutingRepositoryEntry("a".repeat(201))).toBe(false);
    expect(reviewRoutingPrWatchSchema.safeParse({ repositories: ["x".repeat(201)] }).success).toBe(false);
    expect(reviewRoutingPrWatchSchema.safeParse({ repositories: Array.from({ length: 21 }, (_, i) => `o/r${i}`) }).success).toBe(false);
    expect(normalizeReviewRoutingPrWatch({ repositories: ["acme/widgets", "acme/widgets", "other/repo"] }).repositories).toEqual([
      "acme/widgets",
      "other/repo",
    ]);
  });

  it("prWatch: stored values keep, missing fields fill, steward roles deduplicate", () => {
    expect(
      normalizeReviewRoutingSettings({
        prWatch: { repositories: ["acme/widgets"], pollIntervalSec: 90, steward: { roles: ["devops", "devops", "qa"], maxMergesPerSteward: 1 } },
      }).prWatch,
    ).toEqual({
      enabled: true,
      repositories: ["acme/widgets"],
      maxOpenReviewsPerReviewer: DEFAULT_REVIEW_ROUTING_PR_MAX_OPEN_REVIEWS_PER_REVIEWER,
      maxNewAssignmentsPerPass: DEFAULT_REVIEW_ROUTING_PR_MAX_NEW_ASSIGNMENTS_PER_PASS,
      pollIntervalSec: 90,
      steward: { enabled: true, roles: ["devops", "qa"], maxMergesPerSteward: 1 },
    });
  });

  it("boardMerge: absent means the merge is ON with the documented defaults", () => {
    expect(normalizeReviewRoutingSettings({}).boardMerge).toEqual(BOARD_MERGE_DEFAULTS);
    expect(normalizeReviewRoutingBoardMerge(undefined)).toEqual(BOARD_MERGE_DEFAULTS);
    expect(normalizeReviewRoutingBoardMerge({ enabled: false })).toEqual({ ...BOARD_MERGE_DEFAULTS, enabled: false });
  });

  it("boardMerge: a malformed block degrades per field and never switches the merge off", () => {
    for (const malformed of [
      "x",
      [],
      null,
      { enabled: "no" },
      { method: "fast-forward" },
      { baseBranches: [] },
      { baseBranches: "main" },
      { requiredChecks: [""] },
      { repositories: ["not a repo"] },
      { maxMergesPerPass: 0 },
      { maxMergesPerPass: 21 },
    ]) {
      expect(normalizeReviewRoutingBoardMerge(malformed)).toEqual(BOARD_MERGE_DEFAULTS);
    }
    expect(normalizeReviewRoutingBoardMerge({ maxMergesPerPass: 0, method: "merge" })).toEqual({
      ...BOARD_MERGE_DEFAULTS,
      method: "merge",
    });
    // A hand-edited, unreadable block cannot half-apply or blank the siblings of the whole document.
    const settings = normalizeReviewRoutingSettings({ reassignAfterHours: 6, boardMerge: { enabled: 7 } });
    expect(settings.reassignAfterHours).toBe(6);
    expect(settings.boardMerge.enabled).toBe(true);
  });

  it("boardMerge: stored values keep, lists deduplicate, the schema is strict", () => {
    expect(
      normalizeReviewRoutingSettings({
        boardMerge: {
          method: "rebase",
          baseBranches: ["main", "rel/1.6.6", "main"],
          requiredChecks: ["CI result", "CI result", "hot files review"],
          repositories: ["acme/widgets", "acme/widgets"],
          maxMergesPerPass: 5,
        },
      }).boardMerge,
    ).toEqual({
      enabled: true,
      method: "rebase",
      baseBranches: ["main", "rel/1.6.6"],
      requiredChecks: ["CI result", "hot files review"],
      repositories: ["acme/widgets"],
      maxMergesPerPass: 5,
    });
    expect(reviewRoutingBoardMergeSchema.safeParse({ method: "fast-forward" }).success).toBe(false);
    expect(reviewRoutingBoardMergeSchema.safeParse({ maxMergesPerPass: 21 }).success).toBe(false);
    expect(reviewRoutingBoardMergeSchema.safeParse({ baseBranches: [] }).success).toBe(false);
    expect(reviewRoutingBoardMergeSchema.safeParse({ extra: true }).success).toBe(false);
    // The PUT of a screen that does not know the block still validates (defaults fill it).
    expect(reviewRoutingSettingsSchema.parse({ enabled: true }).boardMerge).toEqual(BOARD_MERGE_DEFAULTS);
  });

  it("is a field of the instance general settings, in step with its interface", () => {
    const parsed = instanceGeneralSettingsSchema.parse({
      reviewRouting: {
        enabled: false,
        reviewerRoles: ["qa"],
        maxLoadPerReviewer: 2,
        queueThreshold: 8,
        reassignAfterHours: 12,
        prWatch: { pollIntervalSec: 30 },
      },
    });
    const typed: InstanceGeneralSettings["reviewRouting"] = parsed.reviewRouting;
    expect(typed?.reviewerRoles).toEqual(["qa"]);
    expect(typed?.prWatch.pollIntervalSec).toBe(30);
  });
});
