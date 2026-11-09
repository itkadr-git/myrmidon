// server/src/myrmidon/monitoring/zabbix-sink/index.ts
// myrmidon(1.7-ZABBIX-SINK): entry point of the Zabbix alarm sink. Hands app.ts
// a router (one marked mount line). The sink accepts one Zabbix media-type
// event per request and turns it into a role-task draft, deduped by eventid.

import type { Db } from "@myrmidon/db";
import { zabbixSinkRoutes } from "./routes.js";

export {
  parseZabbixSinkEvent,
  sinkBody,
  sinkTitle,
  zabbixSinkPriority,
  SINK_PRIORITIES,
  ZABBIX_SINK_SEVERITY_CODES,
  type ZabbixSinkEvent,
  type SinkPriority,
} from "./domain.js";
export { createDbZabbixSinkDedupStore, ZABBIX_SINK_DEDUP_GENERAL_KEY, sinkDedupId } from "./store.js";
export { createZabbixSinkService } from "./service.js";
export { zabbixSinkRoutes, ZABBIX_SINK_TOKEN_REF_ENV } from "./routes.js";

/** Router for app.ts: `api.use(zabbixSinkRoutes(db))`. */
export function myrmidonZabbixSinkRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return zabbixSinkRoutes({ db, env });
}
