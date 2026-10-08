// Team-liveness settings (myrmidon TEAM-LIVENESS-SETTINGS) entry point.
//
// The module has no live object to configure: the three behaviour modules read
// the settings row through `teamLivenessReader` on every sweep pass, so a saved
// change reaches them without a restart. This file wires the routes and
// re-exports the reader the sweeps take.

import type { Db } from "@paperclipai/db";
import { teamLivenessRoutes } from "./routes.js";
import { teamLivenessReader, type TeamLivenessReader } from "./settings.js";
import { teamLivenessService, type TeamLivenessService } from "./service.js";

export { teamLivenessService, TEAM_LIVENESS_ACTION } from "./service.js";
export type { TeamLivenessService, TeamLivenessSettingsView } from "./service.js";
export { createTeamLivenessReader, teamLivenessReader } from "./settings.js";
export type { TeamLivenessReader } from "./settings.js";

/** Router for app.ts: GET/PATCH /api/myrmidon/team-liveness. */
export function myrmidonTeamLivenessRoutes(db: Db) {
  const service: TeamLivenessService = teamLivenessService(db);
  return teamLivenessRoutes(db, service);
}

/** The reader the three sweeps are wired with (heartbeat.ts). */
export function myrmidonTeamLivenessReader(db: Db): TeamLivenessReader {
  return teamLivenessReader(db);
}
