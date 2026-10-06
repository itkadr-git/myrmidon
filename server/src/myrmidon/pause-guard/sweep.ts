// The forgotten-pause guard sweep (myrmidon 1.6.5 PAUSE-GUARD).
//
// One pass over the instance: every agent the OPERATOR paused whose pause is
// older than the threshold is resumed through the same wake chain the resume
// route uses, so its queued runs and stranded tasks come back to life. This
// replaces the maintenance script that used to do it from the host with a
// journal file and a fleet allowlist.
//
// Three rules the pass never breaks:
//
// 1. Only an operator pause is lifted. `agents.pause_reason` is `manual` for
//    the pause route and something else for every pause the board sets for its
//    own reasons (`budget`, `system`, `company_archived`, `import`, a plugin
//    note): those are decisions, not forgotten leftovers, and are left alone.
// 2. A name on the allowlist is never resumed. Operators run maintenance
//    windows on named agents; the guard must not fight them.
// 3. At most `maxResumesPerPass` agents are resumed in one pass. The ceiling
//    is what keeps a fleet-wide resume after a long night from waking every
//    stranded backlog at the same instant; the remainder waits for the next
//    pass and is raised as ONE operator card per company (see ./attention.ts).
//
// Every side effect is injected, so the rules above stay pure and the wiring
// lives in index.ts next to the other scheduler sweeps. The database work sits
// behind `PauseGuardStore` so the pass itself is testable without a database
// (the same reason the run admission limits inject their ports).

import { and, asc, eq, lt, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { resolveStatusOnResume } from "../pause-drain.js";
import {
  isAllowlistedName,
  pauseGuardIntervalMs,
  pauseGuardSettingsFor,
  pauseGuardThresholdMs,
  type PauseGuardSettings,
} from "./settings.js";
import { pauseGuardSignalCompanyIds, recordPauseGuardSignal, type PauseGuardAttentionSignal } from "./attention.js";

/** Activity-log action for one automatic resume of a forgotten operator pause. */
export const PAUSE_GUARD_ACTIVITY_ACTION = "agent.pause_guard_resumed";
/** Actor id on the activity rows and the wake requests this sweep issues. */
export const PAUSE_GUARD_ACTOR_ID = "pause_guard";
/** `agents.pause_reason` the operator pause route writes (see paused-stranded.ts). */
export const OPERATOR_PAUSE_REASON = "manual";
/** Wake reason carried by the resume chain this sweep triggers. */
export const PAUSE_GUARD_WAKE_REASON = "pause_guard";

/** One paused agent as the sweep reads it. */
export interface PauseGuardCandidate {
  id: string;
  companyId: string;
  name: string;
  status: string;
  pauseReason: string | null;
  pausedAt: Date | null;
}

export type PauseGuardCandidateVerdict =
  | "eligible"
  | "not_paused"
  | "not_operator_pause"
  | "fresh"
  | "unknown_paused_at"
  | "allowlisted";

export interface PauseGuardCandidateDecision {
  eligible: boolean;
  reason: PauseGuardCandidateVerdict;
}

/**
 * The whole rule set for one agent, pure and side-effect free: the status must
 * be `paused`, the reason must be the operator's, the pause must be older than
 * the threshold, and the name must not be on the allowlist. An agent whose
 * `paused_at` is missing is "cannot judge", never "forgotten".
 */
export function decidePauseGuardCandidate(
  agent: Pick<PauseGuardCandidate, "name" | "status" | "pauseReason" | "pausedAt">,
  options: { now: Date; thresholdMs: number; allowlist: readonly string[] },
): PauseGuardCandidateDecision {
  if (agent.status !== "paused") return { eligible: false, reason: "not_paused" };
  if (agent.pauseReason !== OPERATOR_PAUSE_REASON) {
    return { eligible: false, reason: "not_operator_pause" };
  }
  const pausedAtMs = agent.pausedAt ? agent.pausedAt.getTime() : Number.NaN;
  if (!Number.isFinite(pausedAtMs)) return { eligible: false, reason: "unknown_paused_at" };
  if (options.now.getTime() - pausedAtMs < options.thresholdMs) {
    return { eligible: false, reason: "fresh" };
  }
  if (isAllowlistedName(agent.name, options.allowlist)) {
    return { eligible: false, reason: "allowlisted" };
  }
  return { eligible: true, reason: "eligible" };
}

/**
 * The database steps of a pass, behind one interface. The default
 * implementation is the SQL below; a test supplies its own store, which is how
 * the pass rules (ceiling, allowlist, operator-only pauses, the leftover card)
 * are exercised without an embedded database.
 */
export interface PauseGuardStore {
  /** The oldest forgotten operator pauses first, at most `limit` of them. */
  listStale(input: {
    cutoffIso: string;
    allowlist: readonly string[];
    limit: number;
  }): Promise<PauseGuardCandidate[]>;
  /**
   * How many forgotten operator pauses each company still holds, so the pass
   * can say exactly what the ceiling left behind instead of guessing.
   */
  countByCompany(input: {
    cutoffIso: string;
    allowlist: readonly string[];
  }): Promise<Array<{ companyId: string; count: number }>>;
  /**
   * Flip one agent out of its operator pause and report whether this call did
   * it. The conditional update only matches an agent that still sits in the
   * pause, so a concurrent operator resume or a second pass cannot double-fire
   * and the wake chain runs exactly once per pause.
   */
  claim(input: { agentId: string; cutoffIso: string; now: Date }): Promise<boolean>;
}

export interface PauseGuardActivityInput {
  companyId: string;
  actorType: "system";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}

export interface PauseGuardSweepDeps {
  db?: Db;
  /** Overrides for the database steps; without it `db` is required. */
  store?: PauseGuardStore;
  /** Existing wake chain for a resumed agent (`heartbeat.resumeAgentAfterPause`). */
  resumeWake: (agentId: string) => Promise<unknown>;
  /**
   * The stored `instance_settings.general.pauseGuard` value. Absent means the
   * settings are read from the environment only (a unit test, an early call).
   */
  readStoredSettings?: () => Promise<unknown>;
  /** Records (or clears) the leftover-pauses operator card of one company. */
  recordAttention?: (
    companyId: string,
    signal: Omit<PauseGuardAttentionSignal, "companyId"> | null,
  ) => void;
  /** Optional activity log; absent in unit tests. */
  logActivity?: (input: PauseGuardActivityInput) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface PauseGuardSweepResult {
  /** Forgotten operator pauses found (allowlist excluded). */
  scanned: number;
  /** Agents this pass lifted out of their operator pause. */
  resumed: number;
  /** Forgotten operator pauses left for the next pass (the ceiling). */
  deferred: number;
  /**
   * Candidates the store returned that stopped qualifying before the claim
   * (the operator resumed them, the board paused them for its own reason, a
   * name entered the allowlist).
   */
  skippedChanged: number;
  /** Candidates whose resume or wake failed; the next pass retries them. */
  failed: number;
  /** Companies whose leftover card was raised or refreshed. */
  attentionGroups: number;
  agentIds: string[];
}

function emptyResult(): PauseGuardSweepResult {
  return {
    scanned: 0,
    resumed: 0,
    deferred: 0,
    skippedChanged: 0,
    failed: 0,
    attentionGroups: 0,
    agentIds: [],
  };
}

/** The SQL store over the live database. */
export function createPauseGuardStore(db: Db): PauseGuardStore {
  const staleWhere = (cutoffIso: string, allowlist: readonly string[]) =>
    and(
      eq(companies.status, "active"),
      eq(agents.status, "paused"),
      eq(agents.pauseReason, OPERATOR_PAUSE_REASON),
      lt(agents.pausedAt, new Date(cutoffIso)),
      allowlist.length > 0 ? notInArray(agents.name, [...allowlist]) : undefined,
    );

  return {
    async listStale({ cutoffIso, allowlist, limit }) {
      const rows = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          status: agents.status,
          pauseReason: agents.pauseReason,
          pausedAt: agents.pausedAt,
        })
        .from(agents)
        .innerJoin(companies, eq(companies.id, agents.companyId))
        .where(staleWhere(cutoffIso, allowlist))
        // Oldest pause first: with more leftovers than the ceiling, the most
        // forgotten agent is always the one this pass handles.
        .orderBy(asc(agents.pausedAt), asc(agents.id))
        .limit(Math.max(1, limit));
      return rows as PauseGuardCandidate[];
    },

    async countByCompany({ cutoffIso, allowlist }) {
      return db
        .select({ companyId: agents.companyId, count: sql<number>`count(*)::int` })
        .from(agents)
        .innerJoin(companies, eq(companies.id, agents.companyId))
        .where(staleWhere(cutoffIso, allowlist))
        .groupBy(agents.companyId);
    },

    async claim({ agentId, cutoffIso, now }) {
      // myrmidon(PAUSE-GUARD): the status a resume leaves behind is the same
      // one the resume route writes (a drained pause leaves its run going).
      const resumedStatus = await resolveStatusOnResume(db, agentId);
      const rows = await db
        .update(agents)
        .set({
          status: resumedStatus,
          pauseReason: null,
          pausedAt: null,
          errorReason: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agents.id, agentId),
            eq(agents.status, "paused"),
            eq(agents.pauseReason, OPERATOR_PAUSE_REASON),
            lt(agents.pausedAt, new Date(cutoffIso)),
          ),
        )
        .returning({ id: agents.id });
      return Boolean(rows[0]);
    },
  };
}

export interface PauseGuardSweep {
  /** One pass. Concurrent calls share the in-flight pass instead of stacking a second scan. */
  sweep(options?: { now?: Date; force?: boolean }): Promise<PauseGuardSweepResult>;
  /** The settings in force right now (the stored row over the environment). */
  settings(): Promise<PauseGuardSettings>;
  /** Let the next scheduler tick run a pass instead of waiting out the interval. */
  armNow(): void;
  resetForTest(): void;
}

/**
 * The store a sweep runs on: the injected one, else the SQL store over the live
 * database. A sweep with neither is a wiring error and throws here, so a pass
 * closes over a store that cannot be null.
 */
function resolvePauseGuardStore(deps: PauseGuardSweepDeps): PauseGuardStore {
  const store = deps.store ?? (deps.db ? createPauseGuardStore(deps.db) : null);
  if (!store) throw new Error("pause guard sweep needs a database or a store");
  return store;
}

export function createPauseGuardSweep(deps: PauseGuardSweepDeps): PauseGuardSweep {
  const store = resolvePauseGuardStore(deps);
  let lastSweepAtMs = 0;
  let inFlight: Promise<PauseGuardSweepResult> | null = null;

  async function readSettings(): Promise<PauseGuardSettings> {
    const stored = deps.readStoredSettings ? await deps.readStoredSettings().catch(() => undefined) : undefined;
    return pauseGuardSettingsFor({ stored, env: deps.env ?? process.env }).settings;
  }

  async function runPass(now: Date, settings: PauseGuardSettings): Promise<PauseGuardSweepResult> {
    const result = emptyResult();
    const thresholdMs = pauseGuardThresholdMs(settings);
    const cutoffIso = new Date(now.getTime() - thresholdMs).toISOString();
    const allowlist = settings.allowlist;
    const runStartedAt = new Date().toISOString();

    const perCompany = await store.countByCompany({ cutoffIso, allowlist });
    result.scanned = perCompany.reduce((total, row) => total + row.count, 0);

    const candidates = await store.listStale({
      cutoffIso,
      allowlist,
      limit: settings.maxResumesPerPass,
    });

    const resumedByCompany = new Map<string, number>();

    for (const candidate of candidates) {
      if (result.resumed >= settings.maxResumesPerPass) break;
      try {
        // Re-check immediately before acting: the operator may have resumed
        // the agent, or the board may have re-paused it for its own reason,
        // while this pass worked through the list. The rules are the same ones
        // the SQL prefilter used, read off the candidate the store returned.
        const decision = decidePauseGuardCandidate(candidate, { now, thresholdMs, allowlist });
        if (!decision.eligible) {
          result.skippedChanged += 1;
          continue;
        }

        const claimed = await store.claim({ agentId: candidate.id, cutoffIso, now });
        if (!claimed) {
          result.skippedChanged += 1;
          continue;
        }

        try {
          await deps.resumeWake(candidate.id);
        } catch (err) {
          // Best-effort: the agent is already out of its pause, the next pass
          // sees it as not paused and stops; the wake itself is retried by the
          // other resume paths (pause-drain, stranded recovery).
          logger.warn({ err, agentId: candidate.id }, "pause guard resume wake failed");
        }

        result.resumed += 1;
        result.agentIds.push(candidate.id);
        resumedByCompany.set(candidate.companyId, (resumedByCompany.get(candidate.companyId) ?? 0) + 1);

        await deps.logActivity?.({
          companyId: candidate.companyId,
          actorType: "system",
          actorId: PAUSE_GUARD_ACTOR_ID,
          agentId: candidate.id,
          runId: null,
          action: PAUSE_GUARD_ACTIVITY_ACTION,
          entityType: "agent",
          entityId: candidate.id,
          details: {
            agentName: candidate.name,
            pausedAt: candidate.pausedAt ? candidate.pausedAt.toISOString() : null,
            pausedForMs: candidate.pausedAt ? Math.max(0, now.getTime() - candidate.pausedAt.getTime()) : null,
            thresholdMs,
            wakeReason: PAUSE_GUARD_WAKE_REASON,
          },
        });
      } catch (err) {
        // One agent that refuses to resume (a racing finalization, a database
        // conflict) must not abort the pass; the next one retries it.
        result.failed += 1;
        logger.warn({ err, agentId: candidate.id }, "pause guard resume failed");
      }
    }

    // What the ceiling left behind, exactly, per company: the count this pass
    // found minus what it resumed. A company with nothing left loses its card.
    const leftovers = new Map<string, number>();
    for (const row of perCompany) {
      const remaining = Math.max(0, row.count - (resumedByCompany.get(row.companyId) ?? 0));
      if (remaining > 0) leftovers.set(row.companyId, remaining);
      result.deferred += remaining;
    }

    if (deps.recordAttention) {
      for (const [companyId, deferredCount] of leftovers) {
        deps.recordAttention(companyId, {
          deferredCount,
          resumedCount: resumedByCompany.get(companyId) ?? 0,
          thresholdMinutes: settings.thresholdMinutes,
          activityAt: runStartedAt,
        });
        result.attentionGroups += 1;
      }
      // A company that had a card and has nothing left over this pass — or is
      // gone from the candidate set entirely — loses it in the same pass.
      for (const companyId of pauseGuardSignalCompanyIds()) {
        if (leftovers.has(companyId)) continue;
        deps.recordAttention(companyId, null);
      }
    }

    if (result.deferred > 0) {
      logger.warn(
        { scanned: result.scanned, resumed: result.resumed, deferred: result.deferred, agentIds: result.agentIds },
        "pause guard pass left operator pauses on hold",
      );
    } else if (result.resumed > 0) {
      logger.warn(
        { resumed: result.resumed, agentIds: result.agentIds },
        "pause guard resumed forgotten operator pauses",
      );
    }
    return result;
  }

  return {
    settings: readSettings,
    armNow() {
      lastSweepAtMs = 0;
    },
    resetForTest() {
      lastSweepAtMs = 0;
      inFlight = null;
    },
    async sweep(options = {}) {
      const settings = await readSettings();
      if (!settings.enabled) return emptyResult();
      const now = options.now ?? deps.now?.() ?? new Date();
      if (inFlight) return inFlight;
      if (!options.force && now.getTime() - lastSweepAtMs < pauseGuardIntervalMs(settings)) {
        return emptyResult();
      }
      lastSweepAtMs = now.getTime();
      inFlight = runPass(now, settings).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}