// myrmidon(1.6.6 CH-CONNECTOR-D): the Telegram upload theme of the channel.
//
// The core imports the upload projection from here instead of
// `chat-telegram-photo.js`, so a registered channel connector can serve how an
// outbound file becomes a Telegram attachment; without one the legacy module
// answers (fail-open).
import * as legacy from "../../../services/chat-telegram-photo.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("services/chat-telegram-photo", legacy);

export const telegramAttachmentForUpload: typeof legacy.telegramAttachmentForUpload =
  (...args) => theme().telegramAttachmentForUpload(...args);
