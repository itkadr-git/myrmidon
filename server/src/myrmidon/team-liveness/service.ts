// Read and change the knobs of the three automatic team-liveness behaviours
// without a restart (myrmidon TEAM-LIVENESS-SETTINGS).
//
// Contract: `instance_settings.general.teamLiveness` holds only the keys an
// operator actually saved. Every key that is absent keeps resolving from the
// environment and then from the built-in default, so an existing deployment
// (environment-only, as it was before this module) behaves exactly as before
// until someone saves a value.
//
// A write merges the patch onto the STORED row, never onto the resolved one:
// merging onto resolved values would bake an active environment override into
// the database as if the operator had chosen it, and the override would
// silently become permanent after the variable is removed. Environment stays a
// read-time overlay.
//
// Nothing has to be applied to a live object: the three sweeps read the row
// through `teamLivenessReader` on every pass, so a saved change takes effect
// on the next pass. The GET reports, per key, which layer is in force
// (`sources`), so the operator can see whether the environment still controls a
// field they never saved.
//
// Two overlapping writes can commit their rows in one order and audit them in
// the other; the audit would then disagree with the stored value. Every write
// runs through one queue, exactly as the parallel-helpers and runtime-limits
// transitions do.

import type { Db } from "@paperclipai/db";
import {
  DEFAULT_TEAM_LIVENESS_SETTINGS,
  TEAM_LIVENESS_KEYS,
  TEAM_LIVENESS_NUMBER_BOUNDS,
  resolveTeamLivenessSettings,
  storedTeamLivenessSettingsSchema,
  TEAM_LIVENESS_SETTINGS_KEY,
  type TeamLivenessKey,
  type TeamLivenessSettings,
  type TeamLivenessSettingsPatch,
  type TeamLivenessSource,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import type { instanceSettingsService } from "../../services/instance-settings.js";
import { instanceSettingsService as instanceSettings } from "../../services/instance-settings.js";

/** What the GET view reports. */
export interface TeamLivenessSettingsView {
  /** The values in force right now (stored, else environment, else default). */
  settings: TeamLivenessSettings;
  /** Only the keys the instance saved; an empty object means "environment only". */
  stored: TeamLivenessSettingsPatch;
  /** Per key: which layer the effective value came from. */
  sources: Record<TeamLivenessKey, TeamLivenessSource>;
  /** The built-in defaults, and the bounds a numeric key is clamped to. */
  defaults: TeamLivenessSettings;
  bounds: Record<string, { min: number; max: number; default: number }>;
}

export interface TeamLivenessActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export type TeamLivenessAuditEntry = TeamLivenessActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/**
 * The vendor settings service, narrowed to the two calls this module makes —
 * the same shape the review-routing and plugin-entitlement settings use, so a
 * vendor change to the service type cannot silently widen what we depend on.
 */
export type TeamLivenessSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

export interface TeamLivenessServiceDeps {
  settings: TeamLivenessSettingsService;
  env?: Record<string, string | undefined>;
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: TeamLivenessAuditEntry): Promise<unknown>;
}

export interface TeamLivenessService {
  read(): Promise<TeamLivenessSettingsView>;
  update(patch: TeamLivenessSettingsPatch, actor: TeamLivenessActor): Promise<TeamLivenessSettingsView>;
}

/** `instance.team_liveness.updated` — the audit action of a change. */
export const TEAM_LIVENESS_ACTION = "instance.team_liveness.updated";

let teamLivenessTransitionQueue: Promise<void> = Promise.resolve();

function withTeamLivenessTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = teamLivenessTransitionQueue.then(run);
  teamLivenessTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

/** The saved row, or an empty patch when nothing usable is stored. */
function readStoredTeamLiveness(raw: unknown): TeamLivenessSettingsPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const parsed = storedTeamLivenessSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export function teamLivenessService(
  db: Db,
  overrides: Partial<TeamLivenessServiceDeps> = {},
): TeamLivenessService {
  const deps: TeamLivenessServiceDeps = {
    settings: instanceSettings(db),
    env: process.env,
    listCompanyIds: () => instanceSettings(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    ...overrides,
  };

  function view(rawGeneral: unknown): TeamLivenessSettingsView {
    const general = (rawGeneral ?? {}) as Record<string, unknown>;
    const stored = readStoredTeamLiveness(general[TEAM_LIVENESS_SETTINGS_KEY]);
    const resolved = resolveTeamLivenessSettings({ stored, env: deps.env ?? process.env });
    return {
      settings: resolved.settings,
      stored,
      sources: resolved.sources,
      defaults: DEFAULT_TEAM_LIVENESS_SETTINGS,
      bounds: TEAM_LIVENESS_NUMBER_BOUNDS,
    };
  }

  async function currentGeneral(): Promise<unknown> {
    return deps.settings.getGeneral();
  }

  return {
    read: async () => view(await currentGeneral()),

    update: async (patch, actor) =>
      withTeamLivenessTransition(async () => {
        const general = (await currentGeneral()) as Record<string, unknown>;
        const before = readStoredTeamLiveness(general[TEAM_LIVENESS_SETTINGS_KEY]);
        // Merge onto the stored row, not the resolved values: a key the
        // operator never set must stay unsaved so the environment keeps
        // controlling it.
        const next: TeamLivenessSettingsPatch = { ...before, ...patch };
        const changedKeys = TEAM_LIVENESS_KEYS.filter((key) => before[key] !== next[key]);
        if (changedKeys.length === 0) return view({ [TEAM_LIVENESS_SETTINGS_KEY]: next });

        await deps.settings.updateGeneral({ [TEAM_LIVENESS_SETTINGS_KEY]: next });

        const companyIds = await deps.listCompanyIds();
        await Promise.all(
          companyIds.map((companyId) =>
            deps.logActivity({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: TEAM_LIVENESS_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before, next, changedKeys },
            }),
          ),
        );

        logger.info(
          { teamLiveness: next, changedKeys, actorType: actor.actorType },
          "team liveness settings updated without a restart",
        );
        return view({ [TEAM_LIVENESS_SETTINGS_KEY]: next });
      }),
  };
}
