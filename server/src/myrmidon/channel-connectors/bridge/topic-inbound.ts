// myrmidon(1.6.6 CH-CONNECTOR-D): the topic-inbound theme of the bridge.
//
// The core imports the theme from here instead of
// `telegram-notify/topic-inbound.js`, so a registered channel connector can
// serve the gate, the task title and the task body of a group topic message;
// without one the legacy module answers (fail-open).
import * as legacy from "../../telegram-notify/topic-inbound.js";
import { channelBridgeTheme } from "./themes.js";

const theme = () => channelBridgeTheme("telegram-notify/topic-inbound", legacy);

export const topicInboundAdmitted: typeof legacy.topicInboundAdmitted =
  (...args) => theme().topicInboundAdmitted(...args);

export const topicTaskTitle: typeof legacy.topicTaskTitle =
  (...args) => theme().topicTaskTitle(...args);

export const topicTaskBody: typeof legacy.topicTaskBody =
  (...args) => theme().topicTaskBody(...args);