// myrmidon(1.6.6 CH-CONNECTOR-D): the Telegram media intake theme of the channel.
//
// The core imports the media-provenance theme from here instead of
// `chat-telegram-media-intake.js`, so a registered channel connector can serve
// provenance checks, identification and the rich-attachment binding; without
// one the legacy module answers (fail-open).
import * as legacy from "../../../services/chat-telegram-media-intake.js";
import type {
  TelegramMediaLocator,
  TelegramMediaScope,
} from "../../../services/chat-telegram-media-intake.js";
import { channelBridgeTheme } from "./themes.js";

export type { TelegramMediaLocator, TelegramMediaScope };

const theme = () =>
  channelBridgeTheme("services/chat-telegram-media-intake", legacy);

export const hasTelegramMediaProvenance: typeof legacy.hasTelegramMediaProvenance =
  (...args) => theme().hasTelegramMediaProvenance(...args);

export const identifyTelegramMedia: typeof legacy.identifyTelegramMedia =
  (...args) => theme().identifyTelegramMedia(...args);

export const telegramMediaNeedsIdentification: typeof legacy.telegramMediaNeedsIdentification =
  (...args) => theme().telegramMediaNeedsIdentification(...args);

export const bindTelegramRichAttachment: typeof legacy.bindTelegramRichAttachment =
  (...args) => theme().bindTelegramRichAttachment(...args);
