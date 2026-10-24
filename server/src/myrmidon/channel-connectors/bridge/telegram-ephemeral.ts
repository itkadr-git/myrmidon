// myrmidon(1.6.6 CH-CONNECTOR-D): the ephemeral callback theme of the Telegram channel.
//
// The core imports the callback receipt/provenance theme from here instead of
// `chat-telegram-ephemeral.js`, so a registered channel connector can serve
// receipt parsing, provenance capture/read and the private-action notice;
// without one the legacy module answers (fail-open).
//
// `TELEGRAM_PRIVATE_ACTION_UNAVAILABLE` is notice *data*, not behaviour: the
// stored-row reader `isStoredTelegramPrivateActionUnavailableText` compares
// against exactly this string, and rows already in the database carry it. The
// value therefore stays on the legacy module's constant even when a connector
// serves the theme — a connector replacing the text would orphan every stored
// notice row.
import * as legacy from "../../../services/chat-telegram-ephemeral.js";
import type {
  TelegramCallbackProvenance,
  TelegramCallbackReceipt,
} from "../../../services/chat-telegram-ephemeral.js";
import { channelBridgeTheme } from "./themes.js";

export type { TelegramCallbackProvenance, TelegramCallbackReceipt };

const theme = () =>
  channelBridgeTheme("services/chat-telegram-ephemeral", legacy);

/** Stored-data notice text (contract value, never connector-served; see above). */
export const TELEGRAM_PRIVATE_ACTION_UNAVAILABLE: typeof legacy.TELEGRAM_PRIVATE_ACTION_UNAVAILABLE =
  legacy.TELEGRAM_PRIVATE_ACTION_UNAVAILABLE;

export const isStoredTelegramPrivateActionUnavailableText: typeof legacy.isStoredTelegramPrivateActionUnavailableText =
  (...args) => theme().isStoredTelegramPrivateActionUnavailableText(...args);

export const telegramCallbackThreadId: typeof legacy.telegramCallbackThreadId =
  (...args) => theme().telegramCallbackThreadId(...args);

export const parseTelegramCallbackReceipt: typeof legacy.parseTelegramCallbackReceipt =
  (...args) => theme().parseTelegramCallbackReceipt(...args);

export const captureTelegramCallbackProvenance: typeof legacy.captureTelegramCallbackProvenance =
  (...args) => theme().captureTelegramCallbackProvenance(...args);

export const readTelegramCallbackProvenance: typeof legacy.readTelegramCallbackProvenance =
  (...args) => theme().readTelegramCallbackProvenance(...args);

export const hasTelegramEphemeralInput: typeof legacy.hasTelegramEphemeralInput =
  (...args) => theme().hasTelegramEphemeralInput(...args);

export const sendTelegramCallbackNotice: typeof legacy.sendTelegramCallbackNotice =
  (...args) => theme().sendTelegramCallbackNotice(...args);
