// Live run admission limits (myrmidon C0, RUNTIME-LIMITS): read, change and
// apply the ceilings without restarting the server.
//
// Contract: `instance_settings.general.runLimits` is the source of truth once
// an operator saves it; the environment stays the default for an instance that
// never did (see packages/shared/src/myrmidon-runtime-limits.ts for the
// precedence and the value rules). A change writes the row, records it in the
// activity log for every company, then applies it to the process-wide
// admission and asks the queued-run sweep to run, so runs waiting behind the
// old ceiling start within the resweep delay instead of at the next scheduler
// tick.
//
// Two overlapping requests can commit their rows in one order and reach the
// in-memory apply in the other; the audit log would then disagree with the
// limits actually in force. Every request's read-write-audit-apply sequence
// runs through one queue (see `withRuntimeLimitsTransition`), exactly as the
// task-drain transition does.

import type { Db } from "@paperclipai/db";
import {
  RUN_LIMITS_PATCH_KEYS,
  mergeRunLimits,
  resolveRunLimits,
  type RunLimits,
  type RunLimitsPatch,
  type ResolvedRunLimits,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import type { HostCpuGate } from "../run-admission.js";

/**
 * Effective limits, where each value came from, and — myrmidon(1.6.5 rc.2) —
 * the host CPU reading the ceiling is applied to right now, so the settings
 * page can show the operator the load next to the field instead of only the
 * number they typed.
 */
export type RuntimeLimitsView = ResolvedRunLimits & {
  hostLoad: HostCpuGate | null;
  /**
   * myrmidon(1.6.5 RUN-FAIRNESS): the live queue snapshot — runs in flight
   * against the ceiling, runs still waiting, and the oldest waiter. `null`
   * when the admission or the database is unavailable, so the settings page
   * shows nothing rather than a number it made up.
   */
  queue: {
    /** Runs in flight right now. */
    active: number;
    /** The concurrency ceiling in force, or null when it is off. */
    limit: number | null;
    /** Runs still waiting in the queue. */
    queued: number;
    /** ISO timestamp of the oldest waiting run, or null when the queue is empty. */
    oldestQueuedAt: string | null;
    /** The agent whose run waits longest, or null when the queue is empty. */
    oldestQueuedAgentId: string | null;
  } | null;
};

/** Who changed the limits, for the activity log. */
export interface RuntimeLimitsActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type RuntimeLimitsAuditEntry = RuntimeLimitsActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface RuntimeLimitsServiceDeps {
  settings: {
    getGeneral(): Promise<{ runLimits?: unknown }>;
    updateGeneral(patch: { runLimits: RunLimits }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: RuntimeLimitsAuditEntry): Promise<unknown>;
  /** Put the limits in force on the live admission. */
  apply(limits: RunLimits): void;
  /** Ask the queued-run sweep to run shortly, so held runs start without waiting for the tick. */
  scheduleResweep(): void;
  /**
   * myrmidon(1.6.5 rc.2): the host CPU reading the ceiling is applied to right
   * now — the load, the host's background floor and the hold, if any. `null`
   * when the process has no admission yet, so the view never fails on it.
   */
  hostLoad?(): HostCpuGate | null;
  /**
   * myrmidon(1.6.5 RUN-FAIRNESS): the live queue snapshot for the GET view.
   * `null` when the admission or the database is unavailable, so the view
   * never fails on it.
   */
  queueSnapshot?(): Promise<RuntimeLimitsView["queue"]>;
  env?: Record<string, string | undefined>;
}

export interface RuntimeLimitsService {
  /** Effective limits and where each value came from. */
  read(): Promise<RuntimeLimitsView>;
  /** Persist, audit and apply a patch; returns the limits now in force. */
  update(patch: RunLimitsPatch, actor: RuntimeLimitsActor): Promise<RuntimeLimitsView>;
}

/** `instance.runtime_limits.updated` — the audit action of a limits change. */
export const RUNTIME_LIMITS_ACTION = "instance.runtime_limits.updated";

let runtimeLimitsTransitionQueue: Promise<void> = Promise.resolve();

function withRuntimeLimitsTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = runtimeLimitsTransitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition cannot wedge every later one behind it.
  runtimeLimitsTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function runtimeLimitsService(
  db: Db,
  overrides: Partial<RuntimeLimitsServiceDeps> = {},
): RuntimeLimitsService {
  const deps: RuntimeLimitsServiceDeps = {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    apply: () => undefined,
    scheduleResweep: () => undefined,
    ...overrides,
  };
  const env = deps.env ?? process.env;

  /**
   * myrmidon(1.6.5 rc.2): the live host CPU reading, or null. Reading the gate
   * touches /proc/loadavg and feeds the background floor, so the settings page
   * sees the same numbers the admission is deciding on; a missing admission
   * (a unit test, an early route call) is simply no reading.
   */
  function hostLoad(): HostCpuGate | null {
    return deps.hostLoad?.() ?? null;
  }

  /**
   * myrmidon(1.6.5 RUN-FAIRNESS): the live queue snapshot, or null when the
   * admission or the database is unavailable. Reading it must never fail the
   * view, exactly like the host CPU reading.
   */
  async function queueSnapshot(): Promise<RuntimeLimitsView["queue"]> {
    if (!deps.queueSnapshot) return null;
    try {
      return await deps.queueSnapshot();
    } catch (err) {
      logger.warn({ err }, "run admission queue snapshot unavailable for the runtime limits view");
      return null;
    }
  }

  return {
    read: async (): Promise<RuntimeLimitsView> => {
      const general = await deps.settings.getGeneral();
      return {
        ...resolveRunLimits({ stored: general.runLimits, env }),
        hostLoad: hostLoad(),
        queue: await queueSnapshot(),
      };
    },

    update: async (patch, actor) =>
      withRuntimeLimitsTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveRunLimits({ stored: general.runLimits, env });
        const next = mergeRunLimits(before.limits, patch);
        const changedKeys = RUN_LIMITS_PATCH_KEYS.filter(
          (key) => (before.limits[key] ?? null) !== (next[key] ?? null),
        );

        await deps.settings.updateGeneral({ runLimits: next });

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
              action: RUNTIME_LIMITS_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before.limits, next, changedKeys },
            }),
          ),
        );

        // Only after the row and the audit records are committed: the limits in
        // force must never run ahead of what the log says they are.
        deps.apply(next);
        deps.scheduleResweep();
        logger.info(
          { limits: next, changedKeys, actorType: actor.actorType },
          "run admission limits updated without a restart",
        );
        return {
          ...resolveRunLimits({ stored: next, env }),
          hostLoad: hostLoad(),
          queue: await queueSnapshot(),
        };
      }),
  };
}