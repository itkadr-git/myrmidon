// myrmidon(TEAM-LIVENESS-SETTINGS): the reader the three behaviour modules
// consult on every pass.
//
// The behaviours (AUTO-RESUME, RUN-STALL, IDLE-PICKUP) used to read their
// `MYRMIDON_*` environment variables at construction time, so an operator
// could only change a knob by editing the deployment and restarting the
// server — which drops every run in flight. This reader resolves
// `instance_settings.general.teamLiveness` against the environment on every
// call, so a saved change takes effect on the next pass without a restart.
//
// Precedence and the per-key source report live in the shared contract
// (`packages/shared/src/myrmidon-team-liveness.ts`); this file only supplies
// the stored row and the environment.

import type { Db } from "@paperclipai/db";
import {
  resolveTeamLivenessSettings,
  TEAM_LIVENESS_SETTINGS_KEY,
  type ResolvedTeamLiveness,
} from "@paperclipai/shared";
// The vendor settings service, narrowed to the two calls this module makes —
// the same shape the review-routing and plugin-entitlement settings use, so a
// vendor change to the service type cannot silently widen what we depend on.
import { instanceSettingsService } from "../../services/instance-settings.js";

/** Reads the effective knobs; one call per sweep pass. */
export type TeamLivenessReader = () => Promise<ResolvedTeamLiveness>;

/** The general-settings surface this module reads. */
export type TeamLivenessGeneralReader = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral"
>;

export interface TeamLivenessReaderDeps {
  settings: TeamLivenessGeneralReader;
  env?: Record<string, string | undefined>;
}

/** Test seam: the reader over an injected general-settings port. */
export function createTeamLivenessReader(deps: TeamLivenessReaderDeps): TeamLivenessReader {
  const env = deps.env ?? process.env;
  return async () => {
    const general = (await deps.settings.getGeneral()) as unknown as Record<string, unknown>;
    return resolveTeamLivenessSettings({ stored: general[TEAM_LIVENESS_SETTINGS_KEY], env });
  };
}

/** Wiring for the running server: stored row, then environment, then default. */
export function teamLivenessReader(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): TeamLivenessReader {
  return createTeamLivenessReader({ settings: instanceSettingsService(db), env });
}
