// myrmidon(1.6.6 CH-CONNECTOR-D2): DM progress settings seam.
import * as legacy from "../../telegram-dm-progress/settings.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("telegram-dm-progress/settings", legacy);
export const TELEGRAM_DM_PROGRESS_CACHE_MS = legacy.TELEGRAM_DM_PROGRESS_CACHE_MS;
export const invalidateTelegramDmProgressSettingsCache: typeof legacy.invalidateTelegramDmProgressSettingsCache = (...args) =>
  theme().invalidateTelegramDmProgressSettingsCache(...args);
export const preserveTelegramDmProgressGeneralKey: typeof legacy.preserveTelegramDmProgressGeneralKey = (...args) =>
  theme().preserveTelegramDmProgressGeneralKey(...args);
export type TelegramDmProgressSettingsDeps = legacy.TelegramDmProgressSettingsDeps;
