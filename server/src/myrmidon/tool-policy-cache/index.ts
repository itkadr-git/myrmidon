// server/src/myrmidon/tool-policy-cache/index.ts
//
// myrmidon(DB-PERF-C-P4): real wiring of the tool policy cache settings routes
// for app.ts — the instance settings row and this process's live cache
// counters, the same shape the agent-memory settings routes use. Consumers of
// the cache itself (the tool gateway service) import `runtime.js` directly so
// the hot path does not pull the services barrel in.

import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "../../services/index.js";
import { toolPolicyCacheStats } from "./runtime.js";
import { toolPolicyCacheSettingsRoutes, toolPolicyCacheSettingsService } from "./settings-routes.js";

/** GET/PATCH /api/myrmidon/tool-policy-cache: the TTL behind the policy cache. */
export function myrmidonToolPolicyCacheRoutes(db: Db) {
  const settings = instanceSettingsService(db);
  return toolPolicyCacheSettingsRoutes(
    toolPolicyCacheSettingsService({
      getGeneral: () => settings.getGeneral(),
      updateGeneral: (patch) => settings.updateGeneral(patch),
      stats: () => toolPolicyCacheStats(db),
    }),
  );
}