// Channel settings (myrmidon 1.7-SETTINGS-TO-UI, SETTINGS-UI A):
// GET/PATCH /api/myrmidon/channel-settings.
//
// The Telegram bridge switches, the attachment ceilings and the cross-channel
// numbers live in `instance_settings.general.channelSettings`. Per key the
// server resolves: environment (forced override) → stored value → built-in
// default, and answers with { value, source, default, envName, overridden }
// for every key, so the panel shows where each value in force came from and
// keeps an environment-pinned key read-only. `telegramApiBaseUrl` is
// deployment-only (it points the bridge at a local Bot API server) and is
// shown for reference. Consumers re-read the settings on use, so a change
// applies without a restart.
import { api } from "@/api/client";

/** Where a resolved value came from (the SETTINGS-TO-UI track's source names). */
export type ChannelSettingSource = "ui" | "env" | "default";

export interface ChannelSettingValue<T> {
  value: T;
  source: ChannelSettingSource;
  /** The built-in default: what the key falls back to when nothing is set. */
  default: T;
  /** The environment variable this key maps to. */
  envName: string;
  /** True when the environment pins the value; the panel shows it read-only. */
  overridden: boolean;
}

/** The effective channel settings (mirrors server channel-settings/settings.ts). */
export interface ChannelSettingsView {
  telegramDmConversations: ChannelSettingValue<string>;
  telegramDmStatus: ChannelSettingValue<boolean>;
  telegramSplitMaxParts: ChannelSettingValue<number>;
  telegramFileLimitBytes: ChannelSettingValue<number>;
  paperclipAttachmentMaxBytes: ChannelSettingValue<number>;
  chatCrossChannelMessages: ChannelSettingValue<number>;
  chatCrossChannelMessageChars: ChannelSettingValue<number>;
  chatCrossChannelTotalChars: ChannelSettingValue<number>;
  chatCrossChannelLookbackHours: ChannelSettingValue<number>;
  chatReconcileIntervalMs: ChannelSettingValue<number | null>;
  telegramApiBaseUrl: ChannelSettingValue<string | null>;
}

/** The keys the panel may change (`telegramApiBaseUrl` is deployment-only). */
export type ChannelSettingKey = Exclude<keyof ChannelSettingsView, "telegramApiBaseUrl">;

/** A PATCH body: only the keys present are changed. */
export interface ChannelSettingsPatch {
  telegramDmConversations?: string;
  telegramDmStatus?: boolean;
  telegramSplitMaxParts?: number;
  telegramFileLimitBytes?: number;
  paperclipAttachmentMaxBytes?: number;
  chatCrossChannelMessages?: number;
  chatCrossChannelMessageChars?: number;
  chatCrossChannelTotalChars?: number;
  chatCrossChannelLookbackHours?: number;
  chatReconcileIntervalMs?: number | null;
}

export const channelSettingsQueryKey = ["myrmidon", "channel-settings"] as const;

export const channelSettingsApi = {
  get: () => api.get<ChannelSettingsView>("/myrmidon/channel-settings"),
  update: (patch: ChannelSettingsPatch) =>
    api.patch<ChannelSettingsView>("/myrmidon/channel-settings", patch),
};

export function describeChannelSettingSource(source: ChannelSettingSource | undefined): string {
  switch (source) {
    case "ui":
      return "Saved here";
    case "env":
      return "Environment override";
    default:
      return "Default";
  }
}
