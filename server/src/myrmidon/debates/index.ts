// Asymmetric debates (myrmidon 1.7 DEBATE-ASYM A) entry point.
//
// Router for app.ts:
//   GET/PATCH /api/myrmidon/debate/settings
//   POST /api/myrmidon/companies/:companyId/debates/issues/:issueId/run
//
// Like BUDGET-CONFIG-B there is no startup apply step and no in-process
// cache: the configuration is read at run/PATCH time, so a settings-page
// change reaches the next debate without a server restart, and the stored
// `general.debate` key survives every vendor write of the row (the preserve
// helper registered in services/instance-settings.ts).

import type { Db } from "@paperclipai/db";
import { debateRoutes, debateServiceForDb } from "./routes.js";

export { debateRoutes, debateServiceForDb };
export {
  readDebateSettings,
  preserveDebateGeneralKey,
  DEBATE_SETTINGS_ENV,
  DEBATE_SETTINGS_KEY,
} from "./settings.js";
export {
  createDebateGatewayCall,
  debateGatewayProblem,
  readDebateGatewaySettings,
} from "./gateway.js";
export {
  debateService,
  DebateConfigError,
  type DebateService,
  type DebateServiceDeps,
} from "./service.js";

/** Router for app.ts; a service override lets tests drive the whole API with fakes. */
export function myrmidonDebateRoutes(db: Db, overrides: { service?: ReturnType<typeof debateServiceForDb>; env?: NodeJS.ProcessEnv } = {}) {
  const env = overrides.env ?? process.env;
  return debateRoutes(db, overrides.service ?? debateServiceForDb(db, env), env);
}
