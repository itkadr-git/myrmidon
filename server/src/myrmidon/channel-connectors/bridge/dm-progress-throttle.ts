// myrmidon(1.6.6 CH-CONNECTOR-D2): DM progress throttle seam.
import * as legacy from "../../telegram-dm-progress/throttle.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("telegram-dm-progress/throttle", legacy);
export const decideDmStatusPublish: typeof legacy.decideDmStatusPublish = (...args) =>
  theme().decideDmStatusPublish(...args);
