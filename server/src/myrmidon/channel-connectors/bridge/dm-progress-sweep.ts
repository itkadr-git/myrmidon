// myrmidon(1.6.6 CH-CONNECTOR-D2): DM progress sweep seam.
import * as legacy from "../../telegram-dm-progress/sweep.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("telegram-dm-progress/sweep", legacy);
export const readTelegramDmProgressForSweep: typeof legacy.readTelegramDmProgressForSweep = (...args) =>
  theme().readTelegramDmProgressForSweep(...args);
