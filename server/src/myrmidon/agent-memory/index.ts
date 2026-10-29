// server/src/myrmidon/agent-memory/index.ts
//
// myrmidon(MEMORY-UI): real wiring of the memory routes for app.ts — the
// agent row from the database and the vendor authz asserters, the same shape
// the bot-container routes use (routes-wiring.ts).

import { eq } from "drizzle-orm";
import { agents, type Db } from "@myrmidon/db";
import { assertBoard, hasCompanyAccess } from "../../routes/authz.js";
import { agentMemoryRoutes } from "./routes.js";
import { defaultAgentMemoryDeps } from "./service.js";
import { agentMemorySettingsRoutes, agentMemorySettingsService } from "./settings-routes.js";
import { instanceSettingsService } from "../../services/index.js";
import {
  hindsightModelsAdapter,
  hindsightModelsDbAdapter,
  hindsightRoleToGroup,
  groupToHindsightRole,
  isHindsightGroup,
  formatHindsightApiLimitations,
} from "./hindsight-models-adapter.js";
import { hindsightModelsRoutes } from "./hindsight-models-routes.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function myrmidonAgentMemoryRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return agentMemoryRoutes({
    deps: defaultAgentMemoryDeps(db, env),
    async getAgent(id) {
      // A malformed id is "no such agent", not a database error.
      if (!UUID_PATTERN.test(id)) return null;
      const row = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, id))
        .then((rows) => rows[0] ?? null);
      return row;
    },
    hasCompanyAccess: (req, companyId) => hasCompanyAccess(req, companyId),
    assertBoard: (req) => assertBoard(req),
  });
}

/** GET/PATCH /api/myrmidon/agent-memory: the instance setting behind the Memory tab. */
export function myrmidonAgentMemorySettingsRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const settings = instanceSettingsService(db);
  return agentMemorySettingsRoutes(
    agentMemorySettingsService({
      getGeneral: () => settings.getGeneral(),
      updateGeneral: (patch) => settings.updateGeneral(patch),
      env,
    }),
  );
}

/** GET/PATCH /api/myrmidon/hindsight/model-groups: Hindsight write/summarize/search model groups adapter. */
export function myrmidonHindsightModelsRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const settings = instanceSettingsService(db);
  const adapter = hindsightModelsAdapter({
    getGeneral: () => settings.getGeneral(),
    updateGeneral: (patch) => settings.updateGeneral(patch),
    env,
  });
  return hindsightModelsRoutes(adapter);
}

export {
  hindsightModelsAdapter,
  hindsightModelsDbAdapter,
  hindsightModelsRoutes,
  hindsightRoleToGroup,
  groupToHindsightRole,
  isHindsightGroup,
  formatHindsightApiLimitations,
};
