// server/src/myrmidon/owner-delivery/settings.ts
//
// myrmidon(1.6.5-OWNER-DM-FILTER): read and write
// `instance_settings.general[OWNER_DELIVERY_SETTINGS_KEY]`.
//
// The stored value is the single truth; an absent or malformed row means the
// default mode "owner_decisions_only". Same contract as wip-limit/settings.ts.

import {
  OWNER_DELIVERY_SETTINGS_KEY,
  normalizeOwnerDeliverySettings,
  ownerDeliverySettingsSchema,
  type OwnerDeliverySettings,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

export type OwnerDeliverySettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

/** Read the filter settings (or the defaults when absent). */
export async function readOwnerDeliverySettings(
  settings: OwnerDeliverySettingsService,
): Promise<OwnerDeliverySettings> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizeOwnerDeliverySettings(general[OWNER_DELIVERY_SETTINGS_KEY]);
}

/** Validate and store the full settings object (PUT semantics). */
export async function writeOwnerDeliverySettings(
  settings: OwnerDeliverySettingsService,
  input: OwnerDeliverySettings,
): Promise<OwnerDeliverySettings> {
  const parsed = ownerDeliverySettingsSchema.parse(input);
  await settings.updateGeneral({ [OWNER_DELIVERY_SETTINGS_KEY]: parsed });
  return parsed;
}

/**
 * Keep the stored key across vendor writes of `instance_settings.general` —
 * the same contract every other myrmidon general key follows.
 */
export function preserveOwnerDeliveryGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[OWNER_DELIVERY_SETTINGS_KEY];
  return value === undefined ? {} : { [OWNER_DELIVERY_SETTINGS_KEY]: value };
}
