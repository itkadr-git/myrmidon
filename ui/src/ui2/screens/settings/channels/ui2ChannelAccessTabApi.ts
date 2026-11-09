// ui/src/ui2/screens/settings/channels/ui2ChannelAccessTabApi.ts
//
// myrmidon(UI2-CHANNELS): thin re-export facade for the channel access tab —
// the tab reuses the existing clients `channelSettingsApi` (instance access
// mode, GET/PATCH /myrmidon/channel-settings) and `channelAllowlistApi`
// (who may write to the bots, /api/myrmidon/channel-allowlist). No new wire
// contract here; this module only gives the tab one import point so tests can
// mock a single path.
import {
  channelSettingsApi,
  channelSettingsQueryKey,
  type ChannelAccessMode,
  type ChannelSettingsView,
} from "@/components/myrmidon/channel-allowlist/channelSettingsApi";
import {
  channelAllowlistApi,
  channelAllowlistQueryKey,
  type ChannelAllowlistCreateInput,
} from "@/components/myrmidon/channel-allowlist/channelAllowlistApi";
import { chatEndpointsApi } from "@/api/chatEndpoints";

export {
  channelSettingsApi,
  channelSettingsQueryKey,
  channelAllowlistApi,
  channelAllowlistQueryKey,
  chatEndpointsApi,
};
export type { ChannelAccessMode, ChannelSettingsView, ChannelAllowlistCreateInput };
export type { ChannelAllowedUser } from "@/components/myrmidon/channel-allowlist/channelAllowlistApi";
export type { ChatEndpoint } from "@/api/chatEndpoints";
