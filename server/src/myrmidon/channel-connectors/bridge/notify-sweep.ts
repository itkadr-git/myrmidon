// myrmidon(1.6.6 CH-CONNECTOR-D): the proactivity sweep theme of the Telegram channel.
//
// The head-bot proactivity sweep of `server/src/app.ts` is reached from here
// instead of `telegram-notify/sweep.js`, so a registered channel connector can
// serve the periodic proactivity digests; without one the legacy module
// answers (fail-open).
import * as legacy from "../../telegram-notify/sweep.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("telegram-notify/sweep", legacy);

export const sweepTelegramNotifyProactivity: typeof legacy.sweepTelegramNotifyProactivity =
  (...args) => theme().sweepTelegramNotifyProactivity(...args);
