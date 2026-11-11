// myrmidon(1.6.6 CH-CONNECTOR-D): the rich message intake theme of the Telegram channel.
//
// The core imports the rich-message normalization theme from here instead of
// `chat-telegram-rich-intake.js`, so a registered channel connector can serve
// how a Telegram rich message becomes a chat message plus attachments; without
// one the legacy module answers (fail-open). The rich tree's attachment
// binding lives in the media module and goes through its own seam (point 54
// of the call map), so a connector can serve the whole intake pair.
import * as legacy from "../../../services/chat-telegram-rich-intake.js";
import type { TelegramRichIntake } from "../../../services/chat-telegram-rich-intake.js";
import { channelBridgeTheme } from "./themes.js";

export type { TelegramRichIntake };

const theme = () =>
  channelBridgeTheme("services/chat-telegram-rich-intake", legacy);

export const normalizeTelegramRichMessage: typeof legacy.normalizeTelegramRichMessage =
  (...args) => theme().normalizeTelegramRichMessage(...args);
