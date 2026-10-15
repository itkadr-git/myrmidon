// server/src/myrmidon/foraging/idle-gate-settings.ts
//
// myrmidon(1.6.3-FORAGING-IDLE-GATE): the settings-service half of the idle
// gate toggle. Contract: `instance_settings.general.foragingIdleGate` is the
// source of truth once an operator saves it; the environment
// (`MYRMIDON_FORAGING_IDLE_GATE_ENABLED`) stays the forced override for an
// instance that never did (see
// packages/shared/src/myrmidon-foraging-idle-gate.ts for the precedence and
// the value rules). A change writes the row and records it in the activity
// log — and that is all: the toggle is read on every foraging pass, so the
// next pass already uses it. No restart, no in-process cache to invalidate.

import type { Db } from "@paperclipai/db";
import {
  FORAGING_IDLE_GATE_ENABLED_ENV,
  FORAGING_IDLE_GATE_SETTINGS_KEY,
  resolveForagingIdleGate,
  type ForagingIdleGatePatch,
  type ResolvedForagingIdleGate,
} from "@paperclipai/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";

export { FORAGING_IDLE_GATE_ENABLED_ENV, FORAGING_IDLE_GATE_SETTINGS_KEY };

export type ForagingIdleGateView = ResolvedForagingIdleGate;

/** Who changed the toggle, for the activity log. */
export interface ForagingIdleGateActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** Everything the service needs, so tests can run it without a database. */
export interface ForagingIdleGateServiceDeps {
  getGeneral(): Promise<{ foragingIdleGate?: unknown }>;
  updateGeneral(patch: { foragingIdleGate: { enabled: boolean } }): Promise<unknown>;
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: {
    companyId: string;
    actorType: string;
    actorId: string;
    agentId: string | null;
    runId: string | null;
    agentApiKeyId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }): Promise<unknown>;
  env?: Record<string, string | undefined>;
}

export interface ForagingIdleGateService {
  /** The toggle in force and where it came from. */
  read(): Promise<ForagingIdleGateView>;
  /** Persist and audit a toggle change; returns the toggle now in force. */
  update(patch: ForagingIdleGatePatch, actor: ForagingIdleGateActor): Promise<ForagingIdleGateView>;
}

/** `instance.foraging_idle_gate.updated` — the audit action of a toggle change. */
export const FORAGING_IDLE_GATE_ACTION = "instance.foraging_idle_gate.updated";

/**
 * The toggle in force right now and where it came from. A settings read
 * failure fails open (the default, on): a transient read error cannot wedge
 * the foraging into skipping passes nobody asked to skip.
 */
export function readForagingIdleGate(
  deps: Pick<ForagingIdleGateServiceDeps, "getGeneral" | "env">,
): Promise<ResolvedForagingIdleGate> {
  return foragingIdleGateServiceRead(deps);
}

async function foragingIdleGateServiceRead(
  deps: Pick<ForagingIdleGateServiceDeps, "getGeneral" | "env">,
): Promise<ResolvedForagingIdleGate> {
  let stored: unknown;
  try {
    const general = await deps.getGeneral();
    stored = general?.[FORAGING_IDLE_GATE_SETTINGS_KEY];
  } catch {
    stored = undefined;
  }
  return resolveForagingIdleGate({
    stored,
    env: deps.env ?? process.env,
  });
}

// No preserve-helper on purpose: normalizeGeneralSettings carries
// `foragingIdleGate` through every general write, and a preserve line spread
// after the normalized patch would restore the OLD stored value over a PATCH.

export function foragingIdleGateService(
  db: Db,
  overrides: Partial<ForagingIdleGateServiceDeps> = {},
): ForagingIdleGateService {
  const settings = instanceSettingsService(db);
  const deps: ForagingIdleGateServiceDeps = {
    getGeneral: () => settings.getGeneral(),
    updateGeneral: (patch) =>
      settings.updateGeneral({ foragingIdleGate: patch.foragingIdleGate }),
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: () => Promise.resolve(),
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    read: async () => foragingIdleGateServiceRead(deps),

    update: async (patch, actor) => {
      await deps.updateGeneral({ foragingIdleGate: { enabled: patch.enabled } });
      // The activity log is the audit trail of who flipped the toggle; a
      // logging failure does not roll the change back (the toggle is already
      // committed and the next pass reads it).
      const companyIds = await deps.listCompanyIds().catch(() => [] as string[]);
      for (const companyId of companyIds) {
        await deps
          .logActivity({
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: FORAGING_IDLE_GATE_ACTION,
            entityType: "instance_settings",
            entityId: FORAGING_IDLE_GATE_SETTINGS_KEY,
            details: { enabled: patch.enabled },
          })
          .catch(() => undefined);
      }
      return resolveForagingIdleGate({ stored: { enabled: patch.enabled }, env });
    },
  };
}
