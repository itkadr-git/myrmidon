// server/src/myrmidon/foraging/index.ts
//
// myrmidon(1.6-FORAGE): entry point of FORAGING.
//
// Wires the store, the reader and the candidate port to the database and hands
// app.ts a router. The candidate port is the seam with SKILL-LIFECYCLE: it is
// connected here (the single place of the wiring), so findings with a diff
// become skill candidates through the lifecycle service; a deployment without
// the connection still records them `unverified` through the null port.
//
// 1.6.1 (FORAGING-LIMITS-UI): the settings the sweep runs with are the instance
// settings row (`general.foraging`), resolved on EVERY pass — the env stays the
// per-key override, the built-in default the floor. The wiring reads the row
// through `instanceSettingsService` on each resolve, so a value changed in the
// interface applies with the next pass, no restart. The finance port records
// one `training_charge` event per pass, and the baseline port feeds the
// cost-per-task auto-off rule.

import type { Db } from "@paperclipai/db";
import { financeEvents } from "@paperclipai/db";
import { secretService } from "../../services/index.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { logger } from "../../middleware/logger.js";
import { nullForagingCandidatePort, type ForagingCandidatePort } from "./domain.js";
import { createForagingReader } from "./reader.js";
import { readForagingSettings, resolveForagingEffectiveSettings, foragingSettingsService } from "./settings.js";
import { createForagingService, type ForagingService } from "./service.js";
import { createDbForagingStore, type ForagingStore } from "./store.js";
import { createDbForagingSkillStore, createForagingCandidatePort } from "./candidate-port.js";
import { skillLifecycleService } from "../skill-lifecycle/index.js";
import { foragingRoutes } from "./routes.js";
import {
  foragingIdleGateService,
  readForagingIdleGate,
  FORAGING_IDLE_GATE_ENABLED_ENV,
  FORAGING_IDLE_GATE_SETTINGS_KEY,
} from "./idle-gate-settings.js";
import { foragingIdleGateRoutes } from "./idle-gate-routes.js";
// myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the pass journal and its route.
import { foragingPassJournalService } from "./pass-journal.js";
import { foragingPassRoutes } from "./pass-routes.js";

export {
  FORAGING_BUDGET_CENTS_ENV,
  FORAGING_INTERVAL_SEC_ENV,
  FORAGING_KEY_SECRET_ENV,
  diffSnapshots,
  normalizeSnapshot,
  estimateCostCents,
  decideForagingBudget,
  skillKeyForRole,
  nullForagingCandidatePort,
} from "./domain.js";
export type { ForagingCandidatePort, ForagingSweepResult, ForagingSourceRef } from "./domain.js";
export { readForagingSettings, FORAGING_ENABLED_ENV, foragingSettingsService, resolveForagingEffectiveSettings } from "./settings.js";
export {
  FORAGING_IDLE_GATE_ENABLED_ENV,
  FORAGING_IDLE_GATE_SETTINGS_KEY,
  foragingIdleGateService,
  readForagingIdleGate,
} from "./idle-gate-settings.js";
export { foragingIdleGateRoutes } from "./idle-gate-routes.js";
// myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the pass journal of a company.
export {
  foragingPassJournalService,
  FORAGING_PASS_JOURNAL_KEY,
  type ForagingPassJournalService,
  type ForagingPassSummary,
} from "./pass-journal.js";
export { foragingPassRoutes } from "./pass-routes.js";
export { createForagingService } from "./service.js";
export { createDbForagingStore } from "./store.js";
export { createForagingReader } from "./reader.js";
// myrmidon(1.6.1-FORAGING-LIMITS-UI)
export * from "./limits.js";
export { createForagingCandidatePort, createDbForagingSkillStore, buildCandidateMarkdown } from "./candidate-port.js";
export type { ForagingSkillStore, ForagedSkillRef } from "./candidate-port.js";

/**
 * The candidate port of the running instance.
 *
 * The port is the seam with SKILL-LIFECYCLE: a finding with a diff resolves or
 * creates the company skill, records a revision that shows the diff and moves
 * the skill to `candidate` through the lifecycle service. The wiring is one
 * call site (`foragingWiring` below), so the sweep itself never changes. When
 * the connection cannot be constructed the null port keeps findings
 * `unverified` instead of failing the pass.
 */
export function foragingCandidatePort(db: Db): ForagingCandidatePort {
  try {
    return createForagingCandidatePort({
      skillStore: createDbForagingSkillStore(db),
      lifecycle: skillLifecycleService(db),
      log: logger,
    });
  } catch (error) {
    logger.warn({ error }, "foraging: candidate port could not be constructed, findings stay unverified");
    return nullForagingCandidatePort;
  }
}

export interface ForagingWiring {
  store: ForagingStore;
  service: ForagingService;
  env: NodeJS.ProcessEnv;
}

/** The store, the reader and the service bound to the database. */
export function foragingWiring(db: Db, env: NodeJS.ProcessEnv = process.env): ForagingWiring {
  const store = createDbForagingStore(db);
  const secrets = secretService(db);
  const settings = instanceSettingsService(db);
  const service = createForagingService({
    store,
    reader: createForagingReader({
      env,
      minHostIntervalMs: readForagingSettings(env).minHostIntervalMs,
      readKey: async (companyId, secretName) => {
        if (!secretName) return null;
        const row = await secrets.getByName(companyId, secretName);
        if (!row) return null;
        return secrets.resolveSecretValue(companyId, row.id, "latest");
      },
    }),
    candidatePort: foragingCandidatePort(db),
    db,
    // myrmidon(1.6.3-FORAGING-IDLE-GATE): the toggle is re-read on every
    // pass from instance_settings.general (env is the forced override).
    idleGate: {
      getGeneral: () => instanceSettingsService(db).getGeneral(),
      env,
    },
    // myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): every pass appends itself
    // to the journal, so the "Foraging" page can show the pass history.
    journal: foragingPassJournalService(db),
    // 1.6.1: live settings — the row is read on every pass, no restart.
    resolveSettings: async () => {
      const effective = await resolveForagingEffectiveSettings(settings, env);
      return {
        enabled: effective.settings.enabled,
        intervalMs: effective.intervalMs,
        budget: effective.budget,
        settings: effective.settings,
      };
    },
    // 1.6.1: one training_charge finance event per pass — the learning spend
    // shows as its own "Training" line in the Costs screen, by kind.
    finance: {
      recordTrainingCharge: async (input) => {
        await db.insert(financeEvents).values({
          companyId: input.companyId,
          agentId: input.agentId,
          eventKind: "training_charge",
          direction: "debit",
          biller: "myrmidon",
          provider: "foraging",
          description: input.description,
          amountCents: input.amountCents,
          estimated: true,
          occurredAt: input.occurredAt,
        });
      },
    },
    log: logger,
  });
  return { store, service, env };
}

/** Router for app.ts. */
export function myrmidonForagingRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const wiring = foragingWiring(db, env);
  const settings = instanceSettingsService(db);
  const router = foragingRoutes({
    db,
    store: wiring.store,
    service: wiring.service,
    // 1.6.1: the settings service of the sweep (GET/PATCH /api/myrmidon/foraging-settings).
    settingsService: foragingSettingsService(db, { settings, env }),
    env: wiring.env,
  });
  return router;
}

/**
 * Router for app.ts: GET/PATCH /api/myrmidon/foraging/idle-gate —
 * the settings-page toggle of the idle gate (myrmidon 1.6.3).
 */
export function myrmidonForagingIdleGateRoutes(db: Db) {
  return foragingIdleGateRoutes(db, foragingIdleGateService(db));
}

/**
 * Router for app.ts: GET /api/myrmidon/companies/:id/foraging/passes — the
 * pass history of a company: what each pass read and which roles it left
 * alone, with the reason (myrmidon 1.6.3-FORAGING-IDLE-GATE, UI half).
 */
export function myrmidonForagingPassRoutes(db: Db) {
  return foragingPassRoutes(db, foragingPassJournalService(db));
}
