// myrmidon(REVIEW-ROUTING): read and write `instance_settings.general.reviewRouting`.
//
// The stored value is the single source (no environment fallback: reviewer
// roles and ceilings are a policy choice, not a deployment knob), read on every
// sweep pass so a change applies without a restart. An absent or malformed row
// means the defaults.

import {
  REVIEW_ROUTING_SETTINGS_KEY,
  normalizeReviewRoutingSettings,
  reviewRoutingSettingsSchema,
  type ReviewRoutingSettings,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export type ReviewRoutingSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

export async function readReviewRoutingSettings(
  settings: Pick<ReviewRoutingSettingsService, "getGeneral">,
): Promise<ReviewRoutingSettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizeReviewRoutingSettings(general[REVIEW_ROUTING_SETTINGS_KEY]);
}

/** Validate and store the full settings object (PUT semantics). */
export async function writeReviewRoutingSettings(
  settings: ReviewRoutingSettingsService,
  input: unknown,
): Promise<ReviewRoutingSettings> {
  const parsed = reviewRoutingSettingsSchema.parse(input);
  const next = { ...parsed, reviewerRoles: [...new Set(parsed.reviewerRoles)] };
  await settings.updateGeneral({ [REVIEW_ROUTING_SETTINGS_KEY]: next });
  return next;
}
