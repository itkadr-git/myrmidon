// server/src/myrmidon/channel-allowlist/index.ts
//
// myrmidon(CA-A): the channel allowlist module — the board-decided list of
// who may write to the company's bots (channel identity; a board account is
// optional), the one-line refusal for everyone else, and the owner's
// access-request card. The general channel layer, Telegram first (OPE-4949).

export {
  admitChannelPrincipal,
  admitChannelWriter,
  channelAccessRequestRecipients,
  channelAllowlistService,
  fetchAdmissionRows,
  isAdmittedByRows,
  normalizeChannelHandle,
  raiseChannelAccessRequest,
  type ChannelAdmissionDb,
  type ChannelAllowlistService,
} from "./service.js";
export { channelAllowlistRoutes } from "./routes.js";
export { handleChannelAccessRefusal } from "./refusal.js";
export {
  CHANNEL_ACCESS_MODE_ENV,
  CHANNEL_ACCESS_MODE_KEY,
  DEFAULT_CHANNEL_ACCESS_MODE,
  readChannelAccessMode,
  resolveChannelAccessMode,
  type ChannelAccessMode,
} from "./settings.js";
