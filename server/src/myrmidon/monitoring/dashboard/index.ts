// server/src/myrmidon/monitoring/dashboard/index.ts
// myrmidon(1.6.6 MONITORING C): the fleet dashboard module's public surface —
// the router app.ts mounts (one marked line), the settings store, the source
// clients and the aggregation service. Read-only against both sources; secret
// values are resolved per request and never leave the process.

import type { Db } from "@paperclipai/db";
import { monitoringDashboardRoutes } from "./routes.js";

export {
  MONITORING_SETTINGS_GENERAL_KEY,
  DEFAULT_MONITORING_CONNECTION_SETTINGS,
  createDbMonitoringSettingsStore,
  monitoringConnectionPatchSchema,
  monitoringConnectionSettingsSchema,
  monitoringSettingsView,
} from "./settings.js";
export type {
  MonitoringConnectionPatch,
  MonitoringConnectionSettings,
  MonitoringSettingsStore,
} from "./settings.js";
export { resolveMonitoringTokenRef } from "./token.js";
export { vmClient, VictoriaMetricsError } from "./vm.js";
export type { VmClient, VmClientSettings, VmVectorSample } from "./vm.js";
export { zabbixReadClient, ZabbixReadError, DASHBOARD_ZABBIX_ITEM_KEYS } from "./zabbix.js";
export type { ZabbixReadClient, ZabbixReadSettings, ZabbixHostReading } from "./zabbix.js";
export {
  buildDashboardView,
  buildSelfcheckView,
  dashboardHostQueries,
  defaultRunbookKey,
  DASHBOARD_CONTAINER_QUERIES,
  DASHBOARD_LITELLM_QUERIES,
} from "./service.js";
export {
  classifySourceError,
  emptyDashboardView,
} from "./domain.js";
export type {
  ContainerReading,
  DashboardView,
  HostReading,
  LiteLlmReading,
  SourceStatus,
  VpsReading,
} from "./domain.js";
export { monitoringDashboardRoutes } from "./routes.js";
export type { MonitoringDashboardRoutesDeps } from "./routes.js";

/** Router for app.ts: `api.use(myrmidonMonitoringDashboardRoutes(db))`. */
export function myrmidonMonitoringDashboardRoutes(db: Db) {
  return monitoringDashboardRoutes({ db });
}
