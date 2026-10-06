// myrmidon(REVIEW-ROUTING): pure helpers of the review routing settings screen.
// No React, no network. The bounds mirror the server schema
// (packages/shared/src/myrmidon-review-routing.ts), which validates again.

import type { ReviewRoutingSettings } from "./reviewRoutingApi";

export const REVIEW_ROUTING_MAX_LOAD_MIN = 1;
export const REVIEW_ROUTING_MAX_LOAD_MAX = 100;
export const REVIEW_ROUTING_REASSIGN_HOURS_MAX = 24 * 90;

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
}

export function draftFromSettings(settings: ReviewRoutingSettings): ReviewRoutingDraft {
  return {
    enabled: settings.enabled,
    roles: rolesToText(settings.reviewerRoles),
    maxLoad: String(settings.maxLoadPerReviewer),
    reassignHours: String(settings.reassignAfterHours),
  };
}

/** The settings object a draft saves, or null while any field is invalid. */
export function settingsFromDraft(draft: ReviewRoutingDraft): ReviewRoutingSettings | null {
  const maxLoad = parseBoundedInt(draft.maxLoad, REVIEW_ROUTING_MAX_LOAD_MIN, REVIEW_ROUTING_MAX_LOAD_MAX);
  const hours = parseBoundedInt(draft.reassignHours, 0, REVIEW_ROUTING_REASSIGN_HOURS_MAX);
  if (!maxLoad.ok || !hours.ok) return null;
  return {
    enabled: draft.enabled,
    reviewerRoles: parseRoles(draft.roles),
    maxLoadPerReviewer: maxLoad.value,
    reassignAfterHours: hours.value,
  };
}
