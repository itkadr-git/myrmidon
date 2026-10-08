// myrmidon(1.6.5-OWNER-DM-FILTER): client contract of the owner Telegram
// delivery setting — which cards the instance sends to the task owner's
// Telegram direct messages.
//
// The frozen route contract (server side of the feature, part A):
//   GET   /api/myrmidon/owner-delivery -> { mode: "via_bot" | "owner_decisions_only" | "all" }
//   PATCH /api/myrmidon/owner-delivery    { mode }   (instance admin)
// With nothing stored the server answers `via_bot`, and the normalizer mirrors
// that default for a body that is missing or malformed so a half-written
// setting never renders an empty screen.
//
// The mode values, the default and the normalizer are owned by the shared
// contract `packages/shared/src/myrmidon-owner-delivery.ts`, which part A
// ships through the `@paperclipai/shared` package index. This module re-exports
// them for its own consumers and keeps no second copy of the mode values.
import {
  OWNER_DELIVERY_DEFAULT_MODE,
  OWNER_DELIVERY_MODES,
  normalizeOwnerDeliverySettings,
  type OwnerDeliveryMode,
  type OwnerDeliverySettings,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export { OWNER_DELIVERY_DEFAULT_MODE, normalizeOwnerDeliverySettings };
export type { OwnerDeliveryMode, OwnerDeliverySettings };

/** Narrows an unknown value — a radio value off the DOM, a body off the wire —
 *  to one of the modes the shared contract defines. */
export function isOwnerDeliveryMode(value: unknown): value is OwnerDeliveryMode {
  return typeof value === "string" && (OWNER_DELIVERY_MODES as readonly string[]).includes(value);
}

export const ownerDeliverySettingsQueryKey = ["myrmidon", "owner-delivery", "settings"] as const;

export const ownerDeliveryApi = {
  async getSettings(): Promise<OwnerDeliverySettings> {
    return normalizeOwnerDeliverySettings(await api.get<unknown>("/myrmidon/owner-delivery"));
  },

  async updateSettings(settings: OwnerDeliverySettings): Promise<OwnerDeliverySettings> {
    return normalizeOwnerDeliverySettings(
      await api.patch<unknown>("/myrmidon/owner-delivery", { mode: settings.mode }),
    );
  },
};