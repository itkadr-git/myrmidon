// server/src/myrmidon/telegram-notify/index.ts
//
// myrmidon(1.6.1-TG-NOTIFY-B): entry point of the jobs half of the Telegram notify
// track. The settings routes belong to part A; this module exports only what
// server/src/index.ts and the tests need.
//
// myrmidon(1.6.6 CH-CONNECTOR-D) batch 3 (OPE-6976, call map OPE-6629 points
// 64-67): the direct path is deprecated. The core (`server/src/index.ts`,
// `server/src/app.ts`) reaches the notify jobs entry through the bridge seam
// `channel-connectors/bridge/notify.js` only; with the bridge flag on a
// registered channel connector serves the theme and this module stays behind
// the seam as the legacy fallback. Do not add a new direct importer; removal is
// the follow-up step, not this PR.

export {
  startTelegramNotifyJobs,
  runDigestForCompany,
  runEscalationsForCompany,
  buildDigestSections,
  renderDigestBody,
  parseDigestTime,
  digestAlreadySent,
  resolveTargetConversation,
  readTelegramNotifyTickMs,
  TELEGRAM_NOTIFY_TICK_SEC_ENV,
  telegramNotifyJobPorts,
  type TelegramNotifyJobPorts,
  type TelegramNotifyJobs,
  type AttentionSnapshot,
  type AttentionSnapshotItem,
  type DigestSection,
  type DigestSectionView,
} from "./jobs.js";
export {
  readTelegramNotifyDocument,
  mutateTelegramNotifyDocument,
  preserveTelegramNotifyGeneralKey,
  emptyTelegramNotifyDocument,
  TELEGRAM_NOTIFY_GENERAL_KEY,
  type TelegramNotifyDocument,
} from "./store.js";
export {
  defaultTelegramNotifySettings,
  type TelegramNotifySettings,
  type TelegramNotifyDigestSettings,
  type TelegramNotifyEscalationsSettings,
} from "./settings.js";
// myrmidon(1.6-TG-NOTIFY-C): the board errors channel (severity filter + rate limit,
// delivery through the existing chat publication path).
export * from "./errors.js";
export * from "./errors-settings.js";
export * from "./errors-sweep.js";
// myrmidon(TG-NOTIFY-A): the owner settings routes (GET/PATCH + changelog).
export { myrmidonTelegramNotifyRoutes, telegramNotifyRoutes, type TelegramNotifyRoutesDeps } from "./routes.js";
export { preserveTelegramNotifySettingsGeneralKey } from "./settings-store.js";
