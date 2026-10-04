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
// Failures are per source: one unreachable host writes `last_error` on its row
// and the pass continues with the next source. Nothing here throws at the pass
// level, so a broken source never stops the sweep.

import { and, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
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
import type { ForagingStore } from "./store.js";
import { readForagingIdleGate, type ForagingIdleGateServiceDeps } from "./idle-gate-settings.js";

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

export interface ForagingServiceDeps {
  store: ForagingStore;
  reader: ForagingReader;
  candidatePort: ForagingCandidatePort;
  settings: {
    budget: { maxCostCents: number; enabled: boolean };
  };
  db: Db;
  /** The idle-gate toggle, read on EVERY pass; absent = the default (on). */
  idleGate?: Pick<ForagingIdleGateServiceDeps, "getGeneral" | "env">;
  /** The per-role idle check; defaults to the swarm-queue/agent SQL check. */
  idleCheck?: ForagingIdleCheck;
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

/**
 * The real idle check against the database (the swarm-claim queue semantics).
 *
 * A role's queue is its open `todo`/`in_progress` tasks with NO assignee —
 * the same membership the swarm-claim queue reads (assigned-to-role OR
 * unassigned would double-count work already being executed by an agent of
 * the role; the ticket's queue is "tasks without an assignee"). An idle
 * agent of the role is one with no `todo`/`in_progress` task assigned.
 */
export function createDbForagingIdleCheck(db: Db): ForagingIdleCheck {
  return {
    async roleIdleReason(companyId, role) {
      // 1. The role's queue: open tasks of the company waiting for the role
      //    with no assignee yet. Anything here means work is waiting.
      const queue = await db
        .select({ issueId: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            isNull(issues.assigneeUserId),
            isNull(issues.hiddenAt),
            isNull(issues.conversationAgentId),
            inArray(issues.status, ["todo", "in_progress"]),
            isNull(issues.assigneeAgentId),
            sql`not exists (
              select 1
              from issues child
              where child.company_id = ${issues.companyId}
                and child.parent_id = ${issues.id}
                and child.status not in ('done', 'cancelled')
            )`,
          ),
        )
        .limit(1)
        .catch(() => [] as Array<{ issueId: string }>);
      if (queue.length > 0) return "queue_not_empty";

      // 2. An idle agent of the role: exists unless some agent of the role
      //    holds a todo/in_progress task — a NOT EXISTS anti-join answers
      //    "is at least one agent of the role free".
      const idle = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.role, role),
            notExists(
              db
                .select({ one: sql`1` })
                .from(issues)
                .where(
                  and(
                    eq(issues.companyId, companyId),
                    eq(issues.assigneeAgentId, agents.id),
                    inArray(issues.status, ["todo", "in_progress"]),
                  ),
                ),
            ),
          ),
        )
        .limit(1)
        .catch(() => [] as Array<{ id: string }>);
      if (idle.length === 0) return "no_idle_agent";
      return null;
    },
  };
}

export function createForagingService(deps: ForagingServiceDeps): ForagingService {
  const store = deps.store;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? logger;
  const budget = deps.settings.budget;
  const idleCheck = deps.idleCheck ?? createDbForagingIdleCheck(deps.db);

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
      // The gate toggle is read on EVERY pass: a settings-page change reaches
      // the next pass without a restart (env stays the forced override).
      let gateEnabled = true;
      if (deps.idleGate) {
        try {
          gateEnabled = (await readForagingIdleGate(deps.idleGate)).enabled;
        } catch {
          gateEnabled = true;
        }
      }

      const startedAt = now();
      let sources: ForagingSourceRef[];
      try {
        sources = await store.enabledSources(companyId);
      } catch (err) {
        log.error({ err, companyId }, "foraging: could not list sources");
        return result;
      }

      const state: ForagingBudgetState = { spentCents: 0 };
      const checkedRoles = new Map<string, "queue_not_empty" | "no_idle_agent" | null>();

      for (const source of sources) {
        // The byte size is unknown before the read; budget the read by the
        // accepted answer cap, then settle the real cost after it. A source
        // that would exceed the ceiling is not read at all.
        if (budget.enabled && state.spentCents >= budget.maxCostCents) {
          result.stoppedByBudget = true;
          log.info({ companyId, sourceId: source.id }, "foraging: pass stopped by the budget");
          break;
        }

        // myrmidon(1.6.3-FORAGING-IDLE-GATE): per-role idle check inside the
        // pass. A busy role is skipped (the reason goes to the result and the
        // journal); the pass CONTINUES with the other roles' sources.
        if (gateEnabled) {
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
