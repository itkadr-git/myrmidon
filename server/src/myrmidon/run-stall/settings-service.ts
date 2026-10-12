// Run stall detection settings (myrmidon RUN-STALL-SETTINGS, 1.6.5):
// read, change and apply them without restarting the server.
//
// Contract: `enabled` and the threshold belong to team-liveness (read-only
// here, a PATCH naming them is a 409); `instance_settings.general.runStall` is
// the source of truth for the check interval and the page size once saved; the environment stays the default for an instance that
// never did (see packages/shared/src/myrmidon-run-stall.ts for the precedence
// and the value rules). A change writes the row, records it in the activity
// log for every company, then applies it to the live sweep, so a running
// process picks the new threshold and interval up without a restart and
// without dropping a run in flight.
//
// Two overlapping requests can commit their rows in one order and reach the
// in-memory apply in the other; the audit log would then disagree with the
// settings actually in force. Every request's read-write-audit-apply sequence
// runs through one queue (see `withRunStallTransition`), exactly as the
// runtime-limits transition does.

import type { Db } from "@paperclipai/db";
import {
  RUN_STALL_KEYS,
  RUN_STALL_MANAGED_ELSEWHERE_CODE,
  RUN_STALL_TEAM_LIVENESS_KEYS,
  RUN_STALL_TEAM_LIVENESS_PATH,
  type ResolvedTeamLiveness,
  mergeRunStall,
  resolveRunStall,
  type ResolvedRunStall,
  type RunStallPatch,
  type RunStallValues,
} from "@paperclipai/shared";
import { conflict } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { teamLivenessReader } from "../team-liveness/settings.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";

/**
 * Effective settings and where each value came from. `enabled` and
 * `thresholdSec` are the team-liveness values the sweep really uses
 * (`managedBy` says so); only the interval and the page size are this panel's.
 */
export type RunStallView = ResolvedRunStall & {
  managedBy: { keys: readonly string[]; owner: "team-liveness"; path: string };
};

/** Who changed the settings, for the activity log. */
export interface RunStallActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type RunStallAuditEntry = RunStallActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface RunStallServiceDeps {
  settings: {
    getGeneral(): Promise<{ runStall?: unknown }>;
    updateGeneral(patch: { runStall: RunStallValues }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: RunStallAuditEntry): Promise<unknown>;
  /** Put the settings in force on the live sweep. */
  apply(settings: RunStallValues): void;
  /** Team-liveness reader: the source of truth of `enabled` and the threshold. */
  readLiveness?: () => Promise<ResolvedTeamLiveness>;
  env?: Record<string, string | undefined>;
}

export interface RunStallService {
  /** Effective settings and where each value came from. */
  read(): Promise<RunStallView>;
  /** Persist, audit and apply a patch; returns the settings now in force. */
  update(patch: RunStallPatch, actor: RunStallActor): Promise<RunStallView>;
}

/** `instance.run_stall.updated` — the audit action of a settings change. */
export const RUN_STALL_ACTION = "instance.run_stall.updated";

let runStallTransitionQueue: Promise<void> = Promise.resolve();

function withRunStallTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = runStallTransitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition cannot wedge every later one behind it.
  runStallTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function runStallService(
  db: Db,
  overrides: Partial<RunStallServiceDeps> = {},
): RunStallService {
  const deps: RunStallServiceDeps = {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    apply: () => undefined,
    ...overrides,
  };
  const env = deps.env ?? process.env;
  const readLiveness = deps.readLiveness ?? teamLivenessReader(db, env);

  // The values the sweep really uses for `enabled` and the threshold come from
  // team-liveness; show those, with their own source, never a stale copy.
  async function withTeamLiveness(resolved: ResolvedRunStall): Promise<RunStallView> {
    const liveness = await readLiveness();
    return {
      settings: {
        ...resolved.settings,
        enabled: liveness.settings.runStallEnabled,
        thresholdSec: liveness.settings.runStallThresholdSec,
      },
      sources: {
        ...resolved.sources,
        enabled: liveness.sources.runStallEnabled,
        thresholdSec: liveness.sources.runStallThresholdSec,
      },
      managedBy: {
        keys: RUN_STALL_TEAM_LIVENESS_KEYS,
        owner: "team-liveness",
        path: RUN_STALL_TEAM_LIVENESS_PATH,
      },
    };
  }

  return {
    read: async (): Promise<RunStallView> => {
      const general = await deps.settings.getGeneral();
      return withTeamLiveness(resolveRunStall({ stored: general.runStall, env }));
    },

    update: async (patch, actor) => {
      const refused = RUN_STALL_TEAM_LIVENESS_KEYS.filter((key) => patch[key] !== undefined);
      if (refused.length > 0) {
        throw conflict(
          `${refused.join(", ")} of run stall detection are managed by the team-liveness settings; change runStallEnabled / runStallThresholdSec there (PATCH ${RUN_STALL_TEAM_LIVENESS_PATH})`,
          { code: RUN_STALL_MANAGED_ELSEWHERE_CODE, keys: refused, path: RUN_STALL_TEAM_LIVENESS_PATH },
        );
      }
      return withRunStallTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveRunStall({ stored: general.runStall, env });
        const next = mergeRunStall(before.settings, patch);
        const changedKeys = RUN_STALL_KEYS.filter((key) => before.settings[key] !== next[key]);

        await deps.settings.updateGeneral({ runStall: next });

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
              action: RUN_STALL_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before.settings, next, changedKeys },
            }),
          ),
        );

        // Only after the row and the audit records are committed: the settings
        // in force must never run ahead of what the log says they are.
        deps.apply(next);
        logger.info(
          { settings: next, changedKeys, actorType: actor.actorType },
          "run stall detection settings updated without a restart",
        );
        return withTeamLiveness(resolveRunStall({ stored: next, env }));
      });
    },
  };
}
