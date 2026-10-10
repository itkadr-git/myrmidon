// packages/shared/src/myrmidon-owner-delivery.ts
//
// myrmidon(1.6.5-OWNER-DM-FILTER): the shared contract of the owner-DM
// delivery filter (U2 cards to the task owner's Telegram DM).
//
// When a card has no task-bound chat thread, the myrmidon(U2) fallback would
// otherwise send EVERY pending agent card to the task owner's DM — including
// agent-to-agent operational confirmations. The filter keeps only the cards
// addressed to a human.
//
// The stored value is a single object under
// `instance_settings.general[OWNER_DELIVERY_SETTINGS_KEY]`:
//
//   { mode: "owner_decisions_only" | "all" }
//
// "owner_decisions_only" (the default when the key is absent) publishes to the
// owner DM only when the interaction is addressed to a human; "all" restores
// the pre-filter behaviour (every card goes to the owner DM). The same shape
// is the payload of GET/PATCH /api/myrmidon/owner-delivery.

import { z } from "zod";

/** The instance_settings.general key that stores the owner-delivery filter. */
export const OWNER_DELIVERY_SETTINGS_KEY = "ownerDelivery";

/** The delivery-filter mode. */
export const OWNER_DELIVERY_MODES = ["owner_decisions_only", "all"] as const;
export type OwnerDeliveryMode = (typeof OWNER_DELIVERY_MODES)[number];

/** The mode that applies when nothing is stored yet. */
export const OWNER_DELIVERY_DEFAULT_MODE: OwnerDeliveryMode =
  "owner_decisions_only";

/**
 * The stored/API shape of the owner-delivery filter settings.
 */
export const ownerDeliverySettingsSchema = z
  .object({
    mode: z.enum(OWNER_DELIVERY_MODES),
  })
  .strict();
export type OwnerDeliverySettings = z.infer<typeof ownerDeliverySettingsSchema>;

/**
 * The single audience predicate for owner-DM delivery: a card is meant for a
 * human when no agent is the addressee AND (the interaction's effective
 * resolver policy is `human_only` OR a user is the explicit addressee).
 *
 * This mirrors the owner-decision rule merged on the release line (fix(U2):
 * only owner decisions reach the owner's Telegram DM) verbatim, so the
 * release-line behavior and this mode-aware gate share ONE predicate and
 * never diverge at the same publication point.
 */
export function ownerShouldDecide(input: {
  addresseeAgentId: string | null | undefined;
  effectiveResolverPolicy: string | null | undefined;
  addresseeUserId: string | null | undefined;
}): boolean {
  return (
    !input.addresseeAgentId &&
    (input.effectiveResolverPolicy === "human_only" ||
      Boolean(input.addresseeUserId))
  );
}

/**
 * The filter decision for one card on the owner-DM branch: `true` when the
 * card may be delivered to the owner's DM under `mode`.
 *
 * "all" keeps the pre-filter behavior (every card goes). Otherwise the card
 * must pass the shared human-addressee predicate `ownerShouldDecide` — with
 * the extra owner-precision requirement from part A: a user addressee counts
 * only when it names the task owner (responsibleUserId ?? createdByUserId),
 * so a card addressed to a different user stays board-only.
 */
export function ownerDeliveryAllowsCard(input: {
  mode: OwnerDeliveryMode;
  addresseeAgentId: string | null | undefined;
  effectiveResolverPolicy: string | null | undefined;
  addresseeUserId: string | null | undefined;
  ownerUserId: string | null | undefined;
}): boolean {
  if (input.mode === "all") return true;
  if (!ownerShouldDecide(input)) return false;
  if (input.effectiveResolverPolicy === "human_only") return true;
  return (
    input.ownerUserId != null && input.addresseeUserId === input.ownerUserId
  );
}

/**
 * Coerce an unknown stored value (from instance_settings.general) into the
 * settings shape, defaulting to the default mode on anything invalid.
 */
export function normalizeOwnerDeliverySettings(
  raw: unknown,
): OwnerDeliverySettings {
  const parsed = ownerDeliverySettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return { mode: OWNER_DELIVERY_DEFAULT_MODE };
}
