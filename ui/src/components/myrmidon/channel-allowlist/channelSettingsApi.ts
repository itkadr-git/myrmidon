// myrmidon(CA-A): API client for the channel-settings keys the allowlist
// screen reads and writes: the access mode (`channelAccessMode`) lives in
// the instance channel-settings document (GET/PATCH /myrmidon/channel-settings).
import { api } from "@/api/client";

export type ChannelAccessMode = "sponsor" | "allowlist";

/** The resolved value shape the server answers for every channel setting. */
export interface ChannelSettingValue<T> {
  value: T;
  source: "ui" | "env" | "default";
  default: T;
  envName: string;
  overridden: boolean;
}

export interface ChannelSettingsView {
  channelAccessMode: ChannelSettingValue<string>;
}

export const channelSettingsQueryKey = ["myrmidon", "channel-settings"] as const;

export const channelSettingsApi = {
  read: () => api.get<ChannelSettingsView>("/myrmidon/channel-settings"),
  setAccessMode: (mode: ChannelAccessMode) =>
    api.patch<ChannelSettingsView>("/myrmidon/channel-settings", { channelAccessMode: mode }),
};
