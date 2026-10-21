// myrmidon(1.6.6 CH-CONNECTOR-D2): bridge of the Telegram video-note theme.
import * as legacy from "../../../services/chat-telegram-video-note.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("services/chat-telegram-video-note", legacy);
export const normalizeTelegramVideoNoteAttachments: typeof legacy.normalizeTelegramVideoNoteAttachments = (...args) =>
  theme().normalizeTelegramVideoNoteAttachments(...args);
