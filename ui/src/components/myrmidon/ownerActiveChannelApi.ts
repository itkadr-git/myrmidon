// Owner active channel (myrmidon 1.7-ACTIVE-CHANNEL): the inactivity
// threshold that decides which channel is the owner's active one, and the
// live status. PATCH saves to instance settings; the next delivery decision
// uses it — no server restart.
import type {
  OwnerActiveChannelPatch,
  OwnerActiveChannelSource,
  OwnerActiveChannelView,
  ResolvedOwnerActiveChannelSettings,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export type { OwnerActiveChannelView };
export type OwnerActiveChannelSettingsView = ResolvedOwnerActiveChannelSettings;

export const ownerActiveChannelQueryKey = ["myrmidon", "owner-active-channel"] as const;

export const ownerActiveChannelSettingsApi = {
  get: () => api.get<OwnerActiveChannelView>("/myrmidon/owner/active-channel"),
  update: (patch: OwnerActiveChannelPatch) =>
    api.patch<ResolvedOwnerActiveChannelSettings>("/myrmidon/owner/active-channel", patch),
};

export function describeOwnerActiveThresholdSource(source: OwnerActiveChannelSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "From the server environment";
    default:
      return "Default";
  }
}
