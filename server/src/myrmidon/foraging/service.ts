// server/src/myrmidon/foraging/service.ts
//
// myrmidon(1.6-FORAGE): the periodic comparison pass.
//
// One pass, per company:
//   1. read the enabled sources of the company, oldest check first;
//   2. for each source, take a snapshot through the injected reader (the only
//      place that touches the network, so the pass itself is testable);
//   3. compare with the previous snapshot. The first read of a source stores the
//      baseline and reports no change; a changed source produces a finding;
//   4. hand the finding to the skill-candidate port. While the port is absent
//      (SKILL-LIFECYCLE not merged) the finding stays `unverified` and the pass
//      continues; a refusal from a present port marks it `rejected`;
//   5. stop the pass once the cost estimate reaches the budget ceiling. The stop
//      is a normal outcome: the sources after the stop are untouched and the
//      next pass starts with them.
//
// Failures are per source: one unreachable host writes `last_error` on its row
// and the pass continues with the next source. Nothing here throws at the pass
// level, so a broken source never stops the sweep.

import type { ForagingPassRecord } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import {
  buildSourceResult,
  decideForagingBudget,
  estimateCostCents,
  normalizeSnapshot,
  skillKeyForRole,
  type ForagingBudgetState,
  type ForagingCandidatePort,
  type ForagingSweepResult,
  type ForagingSourceRef,
} from "./domain.js";
import { nullRoleBusyProbe, planIdleGate, type IdleGatePlan, type RoleBusyProbe } from "./agent-idle-check.js";
import type { ForagingStore } from "./store.js";

export interface ForagingReaderResult {
  /** The raw text of the source; the pass normalizes it. */
  text: string;
  /** How many bytes were fetched, for the cost estimate. */
  bytes: number;
}

/** Reads one source. The only network boundary of the pass; injected in tests. */
export interface ForagingReader {
  read(source: ForagingSourceRef, signal: AbortSignal): Promise<ForagingReaderResult>;
}

/**
 * The idle-only ports of the pass. `isIdleOnly` answers the effective rule of
 * the company (stored value, forced by the environment, else the default),
 * `probe` answers which roles have work in flight, and `recordPass` writes one
 * finished pass into the history the screen reads.
 */
export interface ForagingIdleGatePorts {
  isIdleOnly(companyId: string): Promise<boolean>;
  probe: RoleBusyProbe;
  recordPass(companyId: string, record: ForagingPassRecord): Promise<void>;
}

/** The ports used when idle-only is not wired: the rule is off, nothing is recorded. */
export const nullForagingIdleGate: ForagingIdleGatePorts = {
  async isIdleOnly() {
    return false;
  },
  probe: nullRoleBusyProbe,
  async recordPass() {},
};

export interface ForagingServiceDeps {
  store: ForagingStore;
  reader: ForagingReader;
  candidatePort: ForagingCandidatePort;
  settings: {
    budget: { maxCostCents: number; enabled: boolean };
  };
  /** myrmidon(1.6.2-FORAGING-IDLE-GATE): the "только в простое" ports. */
  idleGate?: ForagingIdleGatePorts;
  now?: () => Date;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
}

export interface ForagingService {
  /** One comparison pass over one company. Never throws. */
  runPass(companyId: string): Promise<ForagingSweepResult>;
  /** The budget state of the current UTC month for the screen. */
  budgetState(companyId: string): Promise<{ spentCents: number; maxCostCents: number; enabled: boolean }>;
}

/** The UTC month window the pass spends against. */
function currentUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function createForagingService(deps: ForagingServiceDeps): ForagingService {
  const store = deps.store;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger;
  const budget = deps.settings.budget;
  // myrmidon(1.6.2-FORAGING-IDLE-GATE): the idle-only ports, off when unwired.
  const idleGate = deps.idleGate ?? nullForagingIdleGate;

  /**
   * Closes one pass: the counters go to the log and to the history the screen
   * reads. Recording is best effort — a journal that cannot be written must
   * never fail a pass that already did its work.
   */
  const finish = async (result: ForagingSweepResult, companyId: string): Promise<void> => {
    log.info(
      {
        companyId,
        sourcesRead: result.sourcesRead,
        findings: result.findings,
        candidates: result.candidates,
        spentCents: result.spentCents,
        stoppedByBudget: result.stoppedByBudget,
        errors: result.errors,
        skipReason: result.skipReason,
        skippedRoles: result.skippedRoles,
      },
      "foraging pass done",
    );
    try {
      await idleGate.recordPass(companyId, {
        at: now().toISOString(),
        skipReason: result.skipReason,
        skippedRoles: result.skippedRoles,
        sourcesRead: result.sourcesRead,
        findings: result.findings,
        candidates: result.candidates,
        spentCents: result.spentCents,
        stoppedByBudget: result.stoppedByBudget,
        errors: result.errors,
      });
    } catch (err) {
      log.warn({ err, companyId }, "foraging: could not record the pass");
    }
  };

  const emptyResult = (): ForagingSweepResult => ({
    sourcesRead: 0,
    findings: 0,
    candidates: 0,
    spentCents: 0,
    stoppedByBudget: false,
    errors: 0,
    skipReason: null,
    skippedRoles: [],
  });

  return {
    async budgetState(companyId) {
      const nowDate = now();
      const monthFindings = await store.monthFindingCount(companyId, currentUtcMonthStart(nowDate));
      // The stored finding count is the observable trace of past passes; the
      // ceiling stays the configured one, so the screen can show how close the
      // company is to the limit between passes.
      const spentCents = deps.settings.budget.enabled
        ? Math.min(monthFindings * estimateCostCents(1024), deps.settings.budget.maxCostCents)
        : 0;
      return { spentCents, maxCostCents: budget.maxCostCents, enabled: budget.enabled };
    },

    async runPass(companyId) {
      const result = emptyResult();
      const startedAt = now();
      let sources: ForagingSourceRef[];
      try {
        sources = await store.enabledSources(companyId);
      } catch (err) {
        log.error({ err, companyId }, "foraging: could not list sources");
        return result;
      }
      // myrmidon(1.6.2-FORAGING-IDLE-GATE): learning happens only in the idle
      // time of a role; work always comes first. The rule is read on every pass,
      // so the screen changes the NEXT pass without a restart. A probe that
      // fails never fails the pass: the gate opens and the pass runs exactly as
      // it did before the feature.
      let readable = sources;
      try {
        const idleOnly = await idleGate.isIdleOnly(companyId);
        if (idleOnly && sources.length > 0) {
          const roles = [...new Set(sources.map((source) => source.role))];
          const busyRoles = await idleGate.probe.busyRoles(companyId, roles);
          const plan: IdleGatePlan = planIdleGate({ idleOnly, roles, busyRoles });
          result.skippedRoles = plan.blockedRoles;
          readable = sources.filter((source) => plan.readableRoles.includes(source.role));
          if (plan.skipReason) {
            result.skipReason = plan.skipReason;
            log.info(
              { companyId, roles: plan.blockedRoles },
              "foraging: pass skipped, the roles have work in flight",
            );
            await finish(result, companyId);
            return result;
          }
        }
      } catch (err) {
        log.warn({ err, companyId }, "foraging: idle-only check failed, running the pass as before");
      }

      const state: ForagingBudgetState = { spentCents: 0 };

      for (const source of readable) {
        // The byte size is unknown before the read; budget the read by the
        // accepted answer cap, then settle the real cost after it. A source
        // that would exceed the ceiling is not read at all.
        if (budget.enabled && state.spentCents >= budget.maxCostCents) {
          result.stoppedByBudget = true;
          log.info({ companyId, sourceId: source.id }, "foraging: pass stopped by the budget");
          break;
        }

        const controller = new AbortController();
        let read: ForagingReaderResult;
        try {
          read = await deps.reader.read(source, controller.signal);
        } catch (err) {
          result.errors += 1;
          const message = err instanceof Error ? err.message : String(err);
          await store.saveRead(companyId, source.id, { lastCheckedAt: now(), lastError: message });
          log.warn({ err, companyId, sourceId: source.id }, "foraging: source read failed");
          continue;
        }

        const costCents = estimateCostCents(read.bytes);
        const decision = decideForagingBudget(budget, state, costCents);
        if (!decision.allowed) {
          result.stoppedByBudget = true;
          log.info({ companyId, sourceId: source.id }, "foraging: pass stopped by the budget");
          break;
        }
        state.spentCents = decision.spentCents;
        result.spentCents = state.spentCents;
        result.sourcesRead += 1;

        const current = normalizeSnapshot(read.text);
        let candidateRef: string | null = null;
        if (deps.candidatePort.available && source.lastSnapshot !== null) {
          const diffReady = buildSourceResult({
            previous: source.lastSnapshot,
            current,
            role: source.role,
            candidateRef: null,
            portAvailable: false,
          });
          if (diffReady.finding) {
            try {
              candidateRef = await deps.candidatePort.createFindingCandidate({
                companyId,
                sourceId: source.id,
                role: source.role,
                url: source.url,
                skillKey: skillKeyForRole(source.role),
                summary: diffReady.finding.summary,
                diff: diffReady.finding.diff,
                detectedAt: startedAt,
              });
            } catch (err) {
              result.errors += 1;
              log.warn({ err, companyId, sourceId: source.id }, "foraging: candidate port failed");
            }
          }
        }

        const outcome = buildSourceResult({
          previous: source.lastSnapshot,
          current,
          role: source.role,
          candidateRef,
          portAvailable: deps.candidatePort.available,
        });

        const checkedAt = now();
        await store.saveSnapshot(companyId, source.id, {
          lastSnapshot: current,
          lastSnapshotAt: checkedAt,
          lastCheckedAt: checkedAt,
          lastError: outcome.error,
        });

        if (outcome.finding) {
          await store.insertFinding({
            companyId,
            sourceId: source.id,
            role: source.role,
            status: outcome.finding.status,
            summary: outcome.finding.summary,
            diff: outcome.finding.diff,
            skillKey: skillKeyForRole(source.role),
            candidateRef: outcome.candidateRef,
            reason: outcome.error,
            detectedAt: checkedAt,
          });
          result.findings += 1;
          if (outcome.candidateRef) result.candidates += 1;
        }
      }

      await finish(result, companyId);
      return result;
    },
  };
}