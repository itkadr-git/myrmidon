import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_ROUTING_MAX_LOAD_PER_REVIEWER,
  DEFAULT_REVIEW_ROUTING_REASSIGN_AFTER_HOURS,
  normalizeReviewRoutingSettings,
  reviewRoutingSettingsSchema,
} from "./myrmidon-review-routing.js";
import type { InstanceGeneralSettings } from "./types/instance.js";
import { instanceGeneralSettingsSchema } from "./validators/instance.js";

describe("myrmidon(REVIEW-ROUTING) settings contract", () => {
  it("falls back to the defaults for an absent or unreadable row", () => {
    for (const raw of [undefined, null, "x", { maxLoadPerReviewer: 0 }, { unknown: 1 }]) {
      expect(normalizeReviewRoutingSettings(raw)).toEqual({
        enabled: true,
        reviewerRoles: ["reviewer"],
        maxLoadPerReviewer: DEFAULT_REVIEW_ROUTING_MAX_LOAD_PER_REVIEWER,
        reassignAfterHours: DEFAULT_REVIEW_ROUTING_REASSIGN_AFTER_HOURS,
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
      reassignAfterHours: 0,
    });
  });

  it("rejects out-of-range values and unknown keys", () => {
    expect(reviewRoutingSettingsSchema.safeParse({ maxLoadPerReviewer: 0 }).success).toBe(false);
    expect(reviewRoutingSettingsSchema.safeParse({ maxLoadPerReviewer: 101 }).success).toBe(false);
    expect(reviewRoutingSettingsSchema.safeParse({ reassignAfterHours: -1 }).success).toBe(false);
    expect(reviewRoutingSettingsSchema.safeParse({ reviewerRoles: [""] }).success).toBe(false);
    expect(reviewRoutingSettingsSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("is a field of the instance general settings, in step with its interface", () => {
    const parsed = instanceGeneralSettingsSchema.parse({
      reviewRouting: { enabled: false, reviewerRoles: ["qa"], maxLoadPerReviewer: 2, reassignAfterHours: 12 },
    });
    const typed: InstanceGeneralSettings["reviewRouting"] = parsed.reviewRouting;
    expect(typed?.reviewerRoles).toEqual(["qa"]);
  });
});
