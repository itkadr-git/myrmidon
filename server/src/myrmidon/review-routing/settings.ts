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
} from "@myrmidon/shared";
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
  // myrmidon(OPE-11767): the PUT is the whole object. A client that does not
  // know the `boardMerge` block (the settings screen before it learned the
  // block) omits it, and the schema would then reset a stored value to the
  // defaults — an operator's "merge off" must survive an unrelated save.
  const sentBoardMerge =
    typeof input === "object" && input !== null && !Array.isArray(input) && "boardMerge" in input;
  const boardMerge = sentBoardMerge ? parsed.boardMerge : (await readReviewRoutingSettings(settings)).boardMerge;
  const next = { ...parsed, boardMerge, reviewerRoles: [...new Set(parsed.reviewerRoles)] };
  await settings.updateGeneral({ [REVIEW_ROUTING_SETTINGS_KEY]: next });
  return next;
}
