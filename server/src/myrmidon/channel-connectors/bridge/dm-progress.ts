// myrmidon(1.6.6 CH-CONNECTOR-D2): bridge of the DM progress runtime theme.
import * as legacy from "../../telegram-dm-progress/runtime-steps.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("telegram-dm-progress/runtime-steps", legacy);

export const recordDmProgressStep: typeof legacy.recordDmProgressStep = (...args) =>
  theme().recordDmProgressStep(...args);
export const recordDmProgressRuntimeStatus: typeof legacy.recordDmProgressRuntimeStatus = (...args) =>
  theme().recordDmProgressRuntimeStatus(...args);
export const parseDmProgressLogLine: typeof legacy.parseDmProgressLogLine = (...args) =>
  theme().parseDmProgressLogLine(...args);
export const recordDmProgressLogChunk: typeof legacy.recordDmProgressLogChunk = (...args) =>
  theme().recordDmProgressLogChunk(...args);
export const readDmProgressRuntimeSteps: typeof legacy.readDmProgressRuntimeSteps = (...args) =>
  theme().readDmProgressRuntimeSteps(...args);
export const clearDmProgressRuntimeSteps: typeof legacy.clearDmProgressRuntimeSteps = (...args) =>
  theme().clearDmProgressRuntimeSteps(...args);
export const clearAllDmProgressRuntimeSteps: typeof legacy.clearAllDmProgressRuntimeSteps = (...args) =>
  theme().clearAllDmProgressRuntimeSteps(...args);
