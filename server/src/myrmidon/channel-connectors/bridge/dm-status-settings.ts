// myrmidon(1.6.6 CH-CONNECTOR-D2): DM status settings seam.
import * as legacy from "../../telegram-dm-status-settings.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("telegram-dm-status-settings", legacy);
export const TELEGRAM_DM_STATUS_ENV = legacy.TELEGRAM_DM_STATUS_ENV;
export const TELEGRAM_SPLIT_MAX_PARTS_ENV = legacy.TELEGRAM_SPLIT_MAX_PARTS_ENV;
export const telegramDmStatusEnabled: typeof legacy.telegramDmStatusEnabled = (...args) =>
  theme().telegramDmStatusEnabled(...args);
export const telegramSplitMaxParts: typeof legacy.telegramSplitMaxParts = (...args) =>
  theme().telegramSplitMaxParts(...args);
