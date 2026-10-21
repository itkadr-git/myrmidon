// myrmidon(1.6.6 CH-CONNECTOR-D2): bridge of the Telegram draft control theme.
import * as legacy from "../../../services/chat-telegram-draft-stop.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("services/chat-telegram-draft-stop", legacy);

export const TELEGRAM_DRAFT_ACTION_KIND = legacy.TELEGRAM_DRAFT_ACTION_KIND;
export const TELEGRAM_DRAFT_STOPPED_REASON = legacy.TELEGRAM_DRAFT_STOPPED_REASON;
export const isTelegramDraftStopped: typeof legacy.isTelegramDraftStopped = (value) =>
  theme().isTelegramDraftStopped(value);
export const parseTelegramDraftBinding: typeof legacy.parseTelegramDraftBinding = (...args) =>
  theme().parseTelegramDraftBinding(...args);
export const telegramDraftTextSha256: typeof legacy.telegramDraftTextSha256 = (...args) =>
  theme().telegramDraftTextSha256(...args);
export const telegramPrivateDraftDestination: typeof legacy.telegramPrivateDraftDestination = (...args) =>
  theme().telegramPrivateDraftDestination(...args);
export const captureTelegramGenerationStopped: typeof legacy.captureTelegramGenerationStopped = (...args) =>
  theme().captureTelegramGenerationStopped(...args);
export const telegramGenerationStoppedReceipt: typeof legacy.telegramGenerationStoppedReceipt = (...args) =>
  theme().telegramGenerationStoppedReceipt(...args);
export type TelegramDraftBinding = legacy.TelegramDraftBinding;
export type TelegramDraftControl = legacy.TelegramDraftControl;
export type TelegramDraftStopped = legacy.TelegramDraftStopped;
export type TelegramGenerationStoppedProof = legacy.TelegramGenerationStoppedProof;
export type TelegramGenerationStoppedReceipt = legacy.TelegramGenerationStoppedReceipt;
