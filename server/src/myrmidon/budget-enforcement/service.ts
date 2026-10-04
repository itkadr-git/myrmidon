// Live budget enforcement mode (myrmidon 1.7 BUDGET-CONFIG-B) service.
//
// Contract: `instance_settings.general.budgetEnforcement` is the source of
// truth once an operator saves it; the environment
// (`MYRMIDON_BUDGET_ENFORCEMENT_MODE`) stays the forced override for an
// instance that never did (see packages/shared/src/myrmidon-budget-enforcement.ts
// for the precedence and the value rules). A change writes the row and
// records it in the activity log for every company — and that is all: the
// mode is read at evaluation time, so the next budget evaluation (the next
// cost event, the next run admission) already uses it. No restart, no
// in-process cache to invalidate.
//
// The read-write-audit sequence runs through one queue (the same
// serialization RUNTIME-LIMITS uses) so two overlapping requests cannot
// commit their rows in one order and audit them in the other.

import type { Db } from "@paperclipai/db";
import {
  resolveBudgetEnforcement,
  type BudgetEnforcementMode,
  type BudgetEnforcementPatch,
  type ResolvedBudgetEnforcement,
} from "@paperclipai/shared";
import { instanceSettingsService, logActivity } from "../../services/index.js";

export type BudgetEnforcementView = ResolvedBudgetEnforcement;

/** Who changed the mode, for the activity log. */
export interface BudgetEnforcementActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type BudgetEnforcementAuditEntry = BudgetEnforcementActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface BudgetEnforcementServiceDeps {
  getGeneral(): Promise<{ budgetEnforcement?: unknown }>;
  updateGeneral(patch: { budgetEnforcement: { mode: BudgetEnforcementMode } }): Promise<unknown>;
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: BudgetEnforcementAuditEntry): Promise<unknown>;
  env?: Record<string, string | undefined>;
}

export interface BudgetEnforcementService {
  /** The mode in force and where it came from. */
  read(): Promise<BudgetEnforcementView>;
  /** Persist and audit a mode change; returns the mode now in force. */
  update(patch: BudgetEnforcementPatch, actor: BudgetEnforcementActor): Promise<BudgetEnforcementView>;
}

/** `instance.budget_enforcement.updated` — the audit action of a mode change. */
export const BUDGET_ENFORCEMENT_ACTION = "instance.budget_enforcement.updated";

let budgetEnforcementTransitionQueue: Promise<void> = Promise.resolve();

function withBudgetEnforcementTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = budgetEnforcementTransitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition cannot wedge every later one behind it.
  budgetEnforcementTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function budgetEnforcementService(
  db: Db,
  overrides: Partial<BudgetEnforcementServiceDeps> = {},
): BudgetEnforcementService {
  const settings = instanceSettingsService(db);
  const deps: BudgetEnforcementServiceDeps = {
    getGeneral: () => settings.getGeneral(),
    updateGeneral: (patch) =>
      settings.updateGeneral({ budgetEnforcement: patch.budgetEnforcement }),
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    read: async (): Promise<BudgetEnforcementView> => {
      let stored: unknown;
      try {
        const general = await deps.getGeneral();
        stored = general?.budgetEnforcement;
      } catch {
        stored = undefined;
      }
      return resolveBudgetEnforcement({ stored, env });
    },

    update: async (patch, actor) =>
      withBudgetEnforcementTransition(async () => {
        await deps.updateGeneral({ budgetEnforcement: { mode: patch.mode } });
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
              action: BUDGET_ENFORCEMENT_ACTION,
              entityType: "instance_settings",
              entityId: "budgetEnforcement",
              details: { mode: patch.mode },
            }),
          ),
        );
        return resolveBudgetEnforcement({ stored: { mode: patch.mode }, env });
      }),
  };
}
