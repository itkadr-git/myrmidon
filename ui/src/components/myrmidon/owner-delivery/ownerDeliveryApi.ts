// myrmidon(1.6.5-OWNER-DM-FILTER): client contract of the owner Telegram
// delivery setting — which cards the instance sends to the task owner's
// Telegram direct messages.
//
// The frozen route contract (server side of the feature, part A):
//   GET   /api/myrmidon/owner-delivery -> { mode: "via_bot" | "owner_decisions_only" | "all" }
//   PATCH /api/myrmidon/owner-delivery    { mode }   (instance admin)
// With nothing stored the server answers `via_bot`, and this
// module mirrors that default for a body that is missing or malformed so a
// half-written setting never renders an empty screen.
//
// Part A owns the shared schema (`packages/shared/src/myrmidon-owner-delivery.ts`).
// Until that part is merged the UI keeps its own copy of the same frozen
// contract instead of importing from the shared package.
import { api } from "@/api/client";

/** Which cards reach the owner's Telegram direct messages. */
export type OwnerDeliveryMode = "via_bot" | "owner_decisions_only" | "all";

export interface OwnerDeliverySettings {
  mode: OwnerDeliveryMode;
}

/** The mode the server reports when no setting is stored. */
export const OWNER_DELIVERY_DEFAULT_MODE: OwnerDeliveryMode = "via_bot";

export function isOwnerDeliveryMode(value: unknown): value is OwnerDeliveryMode {
  return value === "via_bot" || value === "owner_decisions_only" || value === "all";
}

/** Reads a settings body off the wire; anything unexpected falls back to the
 *  default mode rather than surfacing a broken value to the screen. */
export function normalizeOwnerDeliverySettings(body: unknown): OwnerDeliverySettings {
  const mode = (body as { mode?: unknown } | null | undefined)?.mode;
  return { mode: isOwnerDeliveryMode(mode) ? mode : OWNER_DELIVERY_DEFAULT_MODE };
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