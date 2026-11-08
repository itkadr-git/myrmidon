// server/src/myrmidon/castes/index.ts
//
// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the caste module's public surface.
//
// The swarm matcher imports its two ports from HERE and nothing else of this
// directory (design.md §7.1 п.3):
//
//   import { resolveTaskCaste, agentNests } from "../castes/index.js";
//   import { taskCasteKeySql, agentNestsAllowSql } from "../castes/index.js";
//
// `resolveTaskCaste` answers which caste takes a task (task -> project ->
// company default), `agentNests` answers where an agent may work. Both read the
// database on every call, so a change in the settings screen or in the agent
// card is visible on the next matcher pass without a restart. The `*Sql`
// builders are the same two rules as expressions for a one-query filter.
//
// Everything else (store, service, routes, wiring) stays internal to the
// module; only wiring.ts is bound to `Db`.

export {
  agentNests,
  agentNestsAllowSql,
  companyDefaultCasteKeySql,
  resolveTaskCaste,
  taskCasteKeySql,
  type TaskCasteScope,
} from "./resolve.js";
export { createAgentNestService, type AgentNestService } from "./nests-service.js";
export { createAgentNestStore, type AgentNestStore } from "./nests-store.js";
export { agentNestRoutes, type AgentNestRoutesDeps } from "./nests-routes.js";
export { createCasteService, type CasteService, type CasteActivityEntry } from "./service.js";
export { createCasteStore, type CasteStore } from "./store.js";
export { casteRoutes, type CasteRoutesDeps } from "./routes.js";
export { myrmidonCasteRoutes, recordAgentNestActivity, recordCasteActivity } from "./wiring.js";