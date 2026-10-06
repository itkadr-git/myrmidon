// server/src/myrmidon/monitoring/alerts/index.ts
// myrmidon(1.6.6-ALERTS): entry point of the monitoring alerts webhook. Hands
// app.ts a router (one marked mount line) and index.ts the sweep (one marked
// call). The webhook accepts Zabbix media-type events and Alertmanager
// (vm-alertmanager) webhooks, dedups alerts by (source, key) in the
// instance_settings JSON column, and auto-closes the board issue on recovery.

import type { Db } from "@paperclipai/db";
import { monitoringAlertsRoutes } from "./routes.js";

export {
  ALERT_SOURCES,
  alertIdentity,
  alertPriority,
  alertmanagerPriority,
  decideDedup,
  detectAlertSource,
  issueBodyFor,
  issueTitleFor,
  parseAlertmanagerAlerts,
  parseZabbixAlert,
  resolvedCommentFor,
  routeAssignee,
  updateCommentFor,
  zabbixPriority,
} from "./domain.js";
export { createDbAlertSettingsStore, alertSettingsView, ALERT_ROUTES_GENERAL_KEY } from "./settings.js";
export { createDbAlertDedupStore, ALERT_DEDUP_GENERAL_KEY } from "./store.js";
export { createAlertService, tokenMatches } from "./service.js";
export { monitoringAlertsRoutes } from "./routes.js";
export {
  startAlertsSweep,
  stopAlertsSweep,
  readAlertSweepSettings,
  ALERTS_SWEEP_INTERVAL_SEC_ENV,
  ALERTS_RETENTION_DAYS_ENV,
} from "./sweep.js";
export { readAlertsSettings, resolveAlertTokenRef, ALERT_WEBHOOK_TOKEN_REF_ENV, ALERTS_COMPANY_ID_ENV } from "./token.js";

/** Router for app.ts: `api.use(monitoringAlertsRoutes(db))`. */
export function myrmidonMonitoringAlertsRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return monitoringAlertsRoutes({ db, env });
}
