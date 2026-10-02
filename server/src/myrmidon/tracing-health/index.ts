// server/src/myrmidon/tracing-health/index.ts
//
// myrmidon(TRACING-HEALTH): real wiring for app.ts — secret store reads and
// the live probe client, the same shape agent-memory/index.ts uses.

import type { Db } from "@paperclipai/db";
import { secretService } from "../../services/index.js";
import { createTracingProbeClient } from "./clients.js";
import { tracingHealthService, type TracingHealthDeps } from "./service.js";

export function defaultTracingHealthDeps(db: Db, env: NodeJS.ProcessEnv = process.env): TracingHealthDeps {
  const secrets = secretService(db);
  return {
    db,
    env,
    async readSecretValue(companyId, secretName) {
      const row = await secrets.getByName(companyId, secretName);
      if (!row) return null;
      return secrets.resolveSecretValue(companyId, row.id, "latest");
    },
    client: createTracingProbeClient(),
    now: () => new Date(),
  };
}

export { tracingHealthService } from "./service.js";
export { myrmidonTracingHealthRoutes } from "./routes.js";
export {
  TRACING_ATTENTION_ACTIVITY_ACTION,
  TRACING_ATTENTION_DEDUP_KEY,
  type TracingAttentionSignal,
  type TracingHealthCard,
  type TracingHealthStatus,
} from "./service.js";
export { readTracingHealthSettings, type TracingHealthSettings } from "./settings.js";
