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
// myrmidon(1.6.3-FORAGING-IDLE-GATE): learning only when idle. Before a
// source is read, the pass checks that the source's ROLE is idle: the role's
// queue (tasks with no assignee, the swarm-claim queue semantics) is empty
// AND at least one agent of the role has no `todo`/`in_progress` task. A busy
// role is skipped with the reason `queue_not_empty` or `no_idle_agent` (per
// role, in the result and the journal); the pass CONTINUES with the other
// roles' sources — the gate filters sources per role inside one pass, it
// never aborts the sweep. The toggle is re-read on every pass (see
// idle-gate-settings.ts), so a settings-page change reaches the next pass
// without a restart.
//
// 1.6.1 (FORAGING-LIMITS-UI): the pass now also
//   - resolves its settings on every run (the wiring passes a resolver, so a
//     change made in the interface applies with the next pass, no restart);
//   - records every read's cost into the spend ledger (`foraging_spend_events`),
//     which the daily/monthly/role/agent limits and the Costs view read;
//   - checks those limits before each read; a crossed limit stops the pass the
//     same normal way and raises one attention signal (soft mode asks the
//     owner);
//   - writes one `training_charge` finance event per pass, so the learning
//     spend shows as its own line in Costs, by role and source url;
//   - runs the auto-off check (owner's 29.09 addition): when the BASELINE
//     cost-per-task mean is above the configured threshold, learning switches
//     itself off (one settings write) and raises a signal.
//
// Failures are per source: one unreachable host writes `last_error` on its row
// and the pass continues with the next source. Nothing here throws at the pass
// level, so a broken source never stops the sweep.

import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { liveClaimCountsByAgent } from "../swarm-claim/matcher.js";
import { listAgentsOfRole, listRoleQueue } from "../swarm-claim/queue.js";
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
import {
  clearForagingLimitSignal,
  decideForagingLimits,
  foragingAutoOffSignal,
  foragingLimitSignal,
  recordForagingAutoOffSignal,
  recordForagingLimitSignal,
  utcDayStart,
  utcMonthStart,
} from "./limits.js";
import type { ForagingSettings } from "@paperclipai/shared";
import type { ForagingStore } from "./store.js";
import { readForagingIdleGate, type ForagingIdleGateServiceDeps } from "./idle-gate-settings.js";
// myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the pass journal of this pass.
import type { ForagingPassJournalService } from "./pass-journal.js";
import type { ForagingPassSkip } from "@paperclipai/shared";

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

/** The per-role idle check the pass runs for the gate (injected in tests). */
export interface ForagingIdleCheck {
  /**
   * `queue_not_empty` — the role's queue (unassigned open tasks) is not
   * empty; `no_idle_agent` — no agent of the role is free of todo/in_progress
   * work; null — the role is idle, the pass may read its sources.
   */
  roleIdleReason(companyId: string, role: string): Promise<"queue_not_empty" | "no_idle_agent" | null>;
}

/** What the service needs to write one finance event (the Costs line). */
export interface ForagingFinancePort {
  /** Record one training_charge debit; failures are logged, never thrown. */
  recordTrainingCharge(input: {
    companyId: string;
    agentId: string | null;
    amountCents: number;
    description: string;
    occurredAt: Date;
  }): Promise<void>;
}

/** The auto-off check: the BASELINE cost-per-task mean, in cents (null = unknown). */
export type ForagingBaselineCostPort = (companyId: string) => Promise<{ meanCostPerTaskCents: number | null }>;

/** Reads the current effective settings (instance row → env → default). */
export type ForagingSettingsResolver = () => Promise<{
  enabled: boolean;
  intervalMs: number;
  budget: { maxCostCents: number; enabled: boolean };
  settings: ForagingSettings;
}>;

export interface ForagingServiceDeps {
  store: ForagingStore;
  reader: ForagingReader;
  candidatePort: ForagingCandidatePort;
  /** The database, for the default per-role idle check. Optional. */
  db?: Db;
  /** The idle-gate toggle, read on EVERY pass; absent means the gate is not applied. */
  idleGate?: Pick<ForagingIdleGateServiceDeps, "getGeneral" | "env">;
  /** The per-role idle check; defaults to the swarm-queue/agent SQL check. */
  idleCheck?: ForagingIdleCheck;
  /**
   * myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the pass journal. Every pass
   * appends itself to it, so the "Foraging" page can show what a pass read and
   * which roles it skipped with which reason. Absent = passes are not recorded.
   */
  journal?: Pick<ForagingPassJournalService, "record">;
  /** The settings resolver — live: called on every pass and budget read. */
  resolveSettings: ForagingSettingsResolver;
  /** The finance port: one training_charge line per pass. Optional in tests. */
  finance?: ForagingFinancePort;
  /** The BASELINE cost-per-task probe for the auto-off rule. Optional. */
  baselineCost?: ForagingBaselineCostPort;
  now?: () => Date;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
}

export interface ForagingService {
  /** One comparison pass over one company. Never throws. */
  runPass(companyId: string): Promise<ForagingSweepResult>;
  /** The budget state of the current UTC day and month for the screen. */
  budgetState(companyId: string): Promise<{
    spentCents: number;
    dayCents: number;
    monthCents: number;
    maxCostCents: number;
    enabled: boolean;
    dailyBudgetCents: number | null;
    monthlyBudgetCents: number | null;
  }>;
}

const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/**
 * The real idle check against the database, built on the swarm-claim reads so
 * "queue" and "free agent" mean exactly what they mean for the idle wake:
 *
 *  - the role's queue is `listRoleQueue` (todo tasks of the role or unassigned,
 *    with the readiness filters: not blocked, not a container, not mid
 *    decomposition, not held);
 *  - a free agent of the role is not paused or in error, has no live
 *    heartbeat run and no live claim (`liveClaimCountsByAgent`).
 */
export function createDbForagingIdleCheck(db: Db): ForagingIdleCheck {
  return {
    async roleIdleReason(companyId, role) {
      const queue = await listRoleQueue(db, companyId, role);
      if (queue.length > 0) return "queue_not_empty";

      const [roleAgents, claims, liveRunRows] = await Promise.all([
        listAgentsOfRole(db, companyId, role),
        liveClaimCountsByAgent(db, companyId),
        db
          .select({ agentId: heartbeatRuns.agentId })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
            ),
          ),
      ]);
      const liveRuns = new Set(liveRunRows.map((row: { agentId: string }) => row.agentId));
      const free = roleAgents.some(
        (agent) =>
          agent.status !== "paused" &&
          agent.status !== "error" &&
          !liveRuns.has(agent.id) &&
          (claims.get(agent.id) ?? 0) === 0,
      );
      return free ? null : "no_idle_agent";
    },
  };
}

export function createForagingService(deps: ForagingServiceDeps): ForagingService {
  const store = deps.store;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger;
  const idleCheck = deps.idleCheck ?? (deps.db ? createDbForagingIdleCheck(deps.db) : null);

  const emptyResult = (): ForagingSweepResult => ({
    sourcesRead: 0,
    findings: 0,
    candidates: 0,
    spentCents: 0,
    stoppedByBudget: false,
    errors: 0,
  });

  return {
    async budgetState(companyId) {
      const { settings } = await deps.resolveSettings();
      const nowDate = now();
      const windows = await store.spendWindows(companyId, utcDayStart(nowDate), utcMonthStart(nowDate));
      return {
        spentCents: windows.monthCents,
        dayCents: windows.dayCents,
        monthCents: windows.monthCents,
        maxCostCents: settings.passBudgetCents ?? 0,
        enabled: settings.passBudgetCents !== null,
        dailyBudgetCents: settings.dailyBudgetCents,
        monthlyBudgetCents: settings.monthlyBudgetCents,
      };
    },

    async runPass(companyId) {
      const result = emptyResult();
      // myrmidon(1.6.3-FORAGING-IDLE-GATE): the toggle is read on EVERY pass, so
      // a settings-page change reaches the next pass without a restart (the
      // environment variable stays the forced override). With no toggle wired
      // (or no idle check to run) the gate is not applied at all. An unreadable
      // settings row reads as "nothing stored" inside readForagingIdleGate, so
      // the default (on) applies and the screen shows the source "default";
      // the catch below only guards a throwing resolver.
      let gateEnabled = false;
      if (deps.idleGate && idleCheck) {
        try {
          gateEnabled = (await readForagingIdleGate(deps.idleGate)).enabled;
        } catch (err) {
          log.warn({ err, companyId }, "foraging: idle gate resolve failed, the gate stays off this pass");
          gateEnabled = false;
        }
      }

      // myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the pass state and the
      // journal writer live above the source listing, because a pass that
      // cannot list its sources is still a pass the history must show.
      const state: ForagingBudgetState = { spentCents: 0 };
      const checkedRoles = new Map<string, "queue_not_empty" | "no_idle_agent" | null>();
      // Every role this pass left alone, so the pass history names the roles,
      // not just a single reason.
      const skipped: ForagingPassSkip[] = [];
      /**
       * Writes the pass into the journal. Called on EVERY exit of the pass —
       * a pass that stopped early is exactly the pass an operator needs to see
       * in the history. Best effort: a journal failure never fails a pass.
       */
      const recordPass = async () => {
        if (!deps.journal) return;
        try {
          await deps.journal.record(companyId, {
            sourcesRead: result.sourcesRead,
            findings: result.findings,
            candidates: result.candidates,
            errors: result.errors,
            stoppedByBudget: result.stoppedByBudget,
            skippedReason: result.skippedReason ?? skipped[0]?.reason ?? null,
            skipped,
          });
        } catch (err) {
          log.warn({ err, companyId }, "foraging: could not record the pass in the journal");
        }
      };

      const startedAt = now();
      const resolved = await deps.resolveSettings();
      const settings = resolved.settings;

      // The auto-off rule (owner's 29.09 addition): the check runs before the
      // pass; when it trips, the pass does not start and the settings row is
      // switched off by the caller-facing wiring (the service only signals,
      // it cannot write instance settings).
      if (
        settings.autoOffCostPerTaskCents !== null &&
        settings.enabled &&
        deps.baselineCost
      ) {
        try {
          const baseline = await deps.baselineCost(companyId);
          if (
            baseline.meanCostPerTaskCents !== null &&
            baseline.meanCostPerTaskCents > settings.autoOffCostPerTaskCents
          ) {
            recordForagingAutoOffSignal(
              foragingAutoOffSignal({
                companyId,
                meanCents: baseline.meanCostPerTaskCents,
                thresholdCents: settings.autoOffCostPerTaskCents,
                activityAt: startedAt.toISOString(),
              }),
            );
            log.warn(
              {
                companyId,
                meanCents: baseline.meanCostPerTaskCents,
                thresholdCents: settings.autoOffCostPerTaskCents,
              },
              "foraging: auto-off by the cost-per-task threshold",
            );
            result.stoppedByBudget = true;
            await recordPass();
            return result;
          }
        } catch (err) {
          log.warn({ err, companyId }, "foraging: baseline cost check failed");
        }
      }

      let sources: ForagingSourceRef[];
      try {
        sources = await store.enabledSources(companyId);
      } catch (err) {
        log.error({ err, companyId }, "foraging: could not list sources");
        await recordPass();
        return result;
      }

      // The spend windows are read once per pass; the per-read decisions add
      // this pass's own spend on top (the rows are written as the pass goes).
      const windows = await store
        .spendWindows(companyId, utcDayStart(startedAt), utcMonthStart(startedAt))
        .catch((err) => {
          log.warn({ err, companyId }, "foraging: spend window read failed");
          return { dayCents: 0, monthCents: 0, byRole: new Map<string, number>(), byAgent: new Map<string, number>() };
        });
      let dayCents = windows.dayCents;
      let monthCents = windows.monthCents;
      const passRoleSpend = new Map<string, number>();

      let stoppedReason: string | null = null;

      const passBudget = {
        maxCostCents: settings.passBudgetCents ?? 0,
        enabled: settings.passBudgetCents !== null,
      };

      for (const source of sources) {
        // The pass budget is checked BEFORE the read (the 1.6 rule): a pass
        // already at its ceiling reads nothing further. The spend limits and
        // the windows are checked against the planned read cost; the real
        // cost settles after the read.
        if (passBudget.enabled && state.spentCents >= passBudget.maxCostCents) {
          result.stoppedByBudget = true;
          stoppedReason = `the per-pass budget of ${settings.passBudgetCents}c was reached`;
          log.info({ companyId, sourceId: source.id }, "foraging: pass stopped by the budget");
          break;
        }
        const plannedCents = estimateCostCents(512 * 1024);
        const roleSpentCents = (windows.byRole.get(source.role) ?? 0) + (passRoleSpend.get(source.role) ?? 0);
        const limitDecision = decideForagingLimits({
          settings,
          spend: { dayCents, monthCents },
          role: source.role,
          roleSpentCents,
          agentId: null,
          agentSpentCents: 0,
          estimateCents: plannedCents,
        });
        if (!limitDecision.allowed) {
          result.stoppedByBudget = true;
          stoppedReason = limitDecision.reason;
          log.info(
            { companyId, sourceId: source.id, reason: limitDecision.reason },
            "foraging: pass stopped by a spend limit",
          );
          break;
        }

        // myrmidon(1.6.3-FORAGING-IDLE-GATE): per-role idle check inside the
        // pass. A busy role is skipped (the reason goes to the result and the
        // journal); the pass CONTINUES with the other roles' sources.
        if (gateEnabled && idleCheck) {
          if (!checkedRoles.has(source.role)) {
            try {
              checkedRoles.set(source.role, await idleCheck.roleIdleReason(companyId, source.role));
            } catch (err) {
              log.warn({ err, companyId, role: source.role }, "foraging: idle check failed, reading anyway");
              checkedRoles.set(source.role, null);
            }
          }
          const reason = checkedRoles.get(source.role);
          if (reason !== null && reason !== undefined) {
            result.skippedReason = reason;
            if (!skipped.some((entry) => entry.role === source.role)) {
              skipped.push({ role: source.role, reason });
            }
            log.info(
              { companyId, role: source.role, sourceId: source.id, reason },
              "foraging: role is busy, skipping its sources this pass",
            );
            continue;
          }
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
        const decision = decideForagingBudget(passBudget, state, costCents);
        if (!decision.allowed) {
          result.stoppedByBudget = true;
          stoppedReason = `the per-pass budget of ${settings.passBudgetCents}c was reached`;
          log.info({ companyId, sourceId: source.id }, "foraging: pass stopped by the budget");
          break;
        }
        state.spentCents = decision.spentCents;
        result.spentCents = state.spentCents;
        result.sourcesRead += 1;
        dayCents += costCents;
        monthCents += costCents;
        passRoleSpend.set(source.role, (passRoleSpend.get(source.role) ?? 0) + costCents);

        // 1.6.1: every read lands in the spend ledger; the write is
        // best-effort — a ledger failure must not break the pass.
        try {
          await store.insertSpendEvent({
            companyId,
            sourceId: source.id,
            role: source.role,
            agentId: null,
            url: source.url,
            costCents,
            outcome: "unchanged",
            occurredAt: now(),
          });
        } catch (err) {
          log.warn({ err, companyId, sourceId: source.id }, "foraging: spend ledger write failed");
        }

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

      await recordPass();
      // 1.6.1: the signal. A pass stopped by a limit raises one attention card
      // (soft mode asks the owner); a pass that ran without a stop clears it.
      if (stoppedReason !== null) {
        recordForagingLimitSignal(
          foragingLimitSignal({
            companyId,
            reason: stoppedReason,
            enforcement: settings.enforcement,
            activityAt: startedAt.toISOString(),
          }),
        );
      } else {
        clearForagingLimitSignal(companyId);
      }

      // 1.6.1: one finance event per pass — the learning spend shows as its
      // own "Training" line in Costs. Best-effort, never breaks the pass.
      if (result.spentCents > 0 && deps.finance) {
        try {
          await deps.finance.recordTrainingCharge({
            companyId,
            agentId: null,
            amountCents: result.spentCents,
            description: "Foraging learning pass",
            occurredAt: now(),
          });
        } catch (err) {
          log.warn({ err, companyId }, "foraging: training charge finance write failed");
        }
      }

      log.info(
        {
          companyId,
          sourcesRead: result.sourcesRead,
          findings: result.findings,
          candidates: result.candidates,
          spentCents: result.spentCents,
          stoppedByBudget: result.stoppedByBudget,
          errors: result.errors,
          skippedReason: result.skippedReason,
        },
        "foraging pass done",
      );
      return result;
    },
  };
}
