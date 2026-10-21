// myrmidon(1.6.6 CH-CONNECTOR-D2): bridge of the DM status publication theme.
import * as legacy from "../../telegram-dm-status-progress.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("telegram-dm-status-progress", legacy);

export const isDmStatusStepEventType: typeof legacy.isDmStatusStepEventType = (...args) =>
  theme().isDmStatusStepEventType(...args);
export const formatDmStatusElapsed: typeof legacy.formatDmStatusElapsed = (...args) =>
  theme().formatDmStatusElapsed(...args);
export const composeDmStatusText: typeof legacy.composeDmStatusText = (...args) =>
  theme().composeDmStatusText(...args);
export const readDmStatusSteps: typeof legacy.readDmStatusSteps = (...args) =>
  theme().readDmStatusSteps(...args);
