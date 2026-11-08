import { and, desc, eq, gt, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { activityLog, agents, companies, heartbeatRuns, type Db } from "@myrmidon/db";
import { logger } from "../middleware/logger.js";
// myrmidon(TEAM-LIVENESS-SETTINGS): the instance settings (and the per-agent card
// switch) this sweep obeys, so the switch can be changed without a restart.
import { resolveAgentTeamLiveness, type ResolvedTeamLiveness } from "@myrmidon/shared";
import { liveAutoResumeSettings } from "./runs-queue-settings/live.js";
// myrmidon(OPE-11947): a run the model pool could not answer is retried by its
// own long policy; auto-resume must not wake the agent's work in the meantime.
import {
  MODEL_UNAVAILABLE_RETRY_MAX_DELAY_MS,
  computeModelUnavailableRetryDelayMs,
  isModelUnavailableRun,
} from "./run-retry-policy/model-unavailable.js";

/**
 * AUTO-RESUME (Myrmidon 1.4).
 *
 * A run that fails (gateway HTTP 500, run timeout, adapter crash) leaves the
 * agent in `error` (`finalizeAgentStatus` in `services/heartbeat.ts`), and the
 * vendor never brings it back on its own: those agents sat in `error` until an
 * operator called resume by hand. This module makes the board resume them with
 * a backoff of 1, 5 and 15 minutes and, when the resumes keep failing, stops
 * and raises a `needs attention` card for the operator instead of retrying
 * forever.
 *
 * It reuses the L3 pause/resume wake chain (`heartbeat.resumeAgentAfterPause`
 * -> `myrmidon/pause-drain.ts`), not a raw `clearError` that would flip the
 * agent back to idle without waking the work it was stranded on.
 *
 * State lives in the existing `agents.metadata` JSON column under the key
 * `myrmidon_auto_resume` (no migration, no new table): the failed-resume
 * counter of the current streak, when the streak last failed, when the next
 * resume is due, and when the module gave up.
 *
 * Three cases differ from the ordinary backoff:
 *  - An agent in `error` with the reason "контейнер не поднят" (1.6.6: its runs
 *    could not reach the gateway, the retries ran out; 07.11 an idle-stopped
 *    container left adm-devops in error for 4.5 h) is not skipped any more: the
 *    sweep first starts the bot container through the board's own path
 *    (`IdleStopService.ensureStartedAndHealthy` = the driver's start, waiting
 *    for healthy), and only a healthy container is followed by the ordinary
 *    resume. A start that fails is retried no sooner than 15 minutes later, 4
 *    attempts in all; then the module gives up with the same operator card as
 *    any other give-up (`agent.auto_resume_exhausted`, critical
 *    `agent_error_alert`). Each attempt is written to the state before the
 *    start (`containerStartFailures`), so a crash or an overlapping pass cannot
 *    repeat it, and a successful start replaces the whole state with the resume
 *    state, which counts towards the ordinary cap (a container that starts and
 *    still refuses the gateway cannot loop for ever).
 *  - (OPE-11947) An agent whose last finished run is model-unavailable (`resultJson.model_unavailable`:
 *    the model pool is out of quota or down) is resumed on the long model-unavailable
 *    schedule, not the 1/5/15 min one: 30 min, 1 h, 2 h, 4 h, then every 6 h after
 *    that run finished (`computeModelUnavailableRetryDelayMs`). A resume wakes
 *    every task the agent is stranded on and each new run fails on the same quota
 *    again, so it must not be quick; but the quota resets some day, so these
 *    resumes never count towards the attempt cap and never give up. The agent is
 *    back within 6 h of the reset. The series counter lives in the same state
 *    (`modelUnavailableResumes`) and starts over once the last run is not
 *    model-unavailable: the ordinary backoff and the cap apply again.
 *  - A give-up is re-armed only by an operator action: an `agent.resumed`,
 *    `agent.updated` or `agent.error_cleared` activity row written by a user
 *    for this agent after `exhaustedAt`. A bare `agents.updated_at` change is
 *    not an operator action, because runs and status changes move it too; it
 *    used to re-arm the streak a few minutes after every give-up.
 */

export const AUTO_RESUME_ENABLED_ENV = "MYRMIDON_AUTO_RESUME_ENABLED";
export const AUTO_RESUME_BACKOFF_MS_ENV = "MYRMIDON_AUTO_RESUME_BACKOFF_MS";
export const AUTO_RESUME_MAX_ATTEMPTS_ENV = "MYRMIDON_AUTO_RESUME_MAX_ATTEMPTS";
export const AUTO_RESUME_INTERVAL_SEC_ENV = "MYRMIDON_AUTO_RESUME_INTERVAL_SEC";
export const AUTO_RESUME_WINDOW_MS_ENV = "MYRMIDON_AUTO_RESUME_WINDOW_MS";

/** Backoff between resume attempts: 1, 5 and 15 minutes. */
export const DEFAULT_AUTO_RESUME_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000];
/** Failed resumes in one streak before the module stops and raises the card. */
export const DEFAULT_AUTO_RESUME_MAX_ATTEMPTS = 3;
/** The sweep runs on every scheduler tick (~30 s); this gate keeps it per-minute. */
export const DEFAULT_AUTO_RESUME_INTERVAL_SEC = 60;
export const MIN_AUTO_RESUME_INTERVAL_SEC = 10;
/** A streak whose last failure is older than this is treated as a new episode. */
export const DEFAULT_AUTO_RESUME_WINDOW_MS = 60 * 60 * 1000;

/**
 * myrmidon(1.6.6 AUTO-RESUME container): the `errorReason` that `finalizeAgentStatus` /
 * `scheduleBoundedRetryForRun` (services/heartbeat.ts) write when the gateway connect
 * retries of a run ran out, i.e. the bot container is not up.
 */
export const AUTO_RESUME_CONTAINER_NOT_STARTED_REASON = "контейнер не поднят";
/** A failed container start is retried no sooner than this after the previous attempt. */
export const AUTO_RESUME_CONTAINER_START_RETRY_MS = 15 * 60 * 1000;
/** Container start attempts in one series before the module gives up and raises the operator card. */
export const AUTO_RESUME_CONTAINER_START_MAX_ATTEMPTS = 4;
/** A series whose last attempt is older than two retry steps is a new episode (the counter is stale). */
const AUTO_RESUME_CONTAINER_START_SERIES_WINDOW_MS = 2 * AUTO_RESUME_CONTAINER_START_RETRY_MS;
/** Activity-log action for one failed container start (the board will retry, or give up after the cap). */
export const AUTO_RESUME_CONTAINER_START_FAILED_ACTIVITY_ACTION = "agent.auto_resume_container_start_failed";

/** Key of the state object inside `agents.metadata`. */
export const AUTO_RESUME_METADATA_KEY = "myrmidon_auto_resume";
/** Activity-log action for one automatic resume (part E reads this for the 24 h metric). */
export const AUTO_RESUME_ACTIVITY_ACTION = "agent.auto_resume_issued";
/** Activity-log action for giving up on an agent after the attempt cap. */
export const AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION = "agent.auto_resume_exhausted";
/**
 * Activity-log actions (written by `routes/agents.ts` with `actor_type = 'user'`,
 * entity `agent`) that count as an operator acting on an agent after a give-up.
 * The same `agent.updated` is also written by the system (`actor_type = 'system'`),
 * so the actor type is part of the match.
 */
export const AUTO_RESUME_OPERATOR_ACTIVITY_ACTIONS: readonly string[] = [
  "agent.resumed",
  "agent.updated",
  "agent.error_cleared",
];

const AUTO_RESUME_ACTOR_ID = "auto_resume";

export interface AutoResumeSettings {
  enabled: boolean;
  /** Backoff step in milliseconds per attempt index; the last step repeats. */
  backoffMs: number[];
  maxAttempts: number;
  intervalSec: number;
  failureWindowMs: number;
}

/**
 * The feature ships enabled (a defect fix per CONVENTIONS.md §8): an unset or
 * unrecognized value keeps it on. Only an explicit off value disables it.
 * OPE-4096: resolves live (UI value → env forced override → default on).
 */
export function readAutoResumeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return liveAutoResumeSettings(env).enabled;
}

export function readAutoResumeSettings(env: NodeJS.ProcessEnv = process.env): AutoResumeSettings {
  // OPE-4096: resolve live (UI value → env forced override → default) so a
  // settings-page save applies without a restart; an explicit env value wins.
  const live = liveAutoResumeSettings(env);
  return {
    enabled: live.enabled,
    backoffMs: live.backoffMs,
    maxAttempts: live.maxAttempts,
    intervalSec: Math.max(MIN_AUTO_RESUME_INTERVAL_SEC, live.intervalSec),
    failureWindowMs: live.windowMs,
  };
}

/** Backoff step for the Nth attempt (index clamped to the last configured step). */
export function backoffForAttempt(backoffMs: readonly number[], attemptIndex: number): number {
  if (backoffMs.length === 0) return DEFAULT_AUTO_RESUME_BACKOFF_MS[0];
  const index = Math.min(Math.max(0, Math.floor(attemptIndex)), backoffMs.length - 1);
  return backoffMs[index]!;
}

export interface AutoResumeState {
  /** Failed-resume count in the current streak. */
  failures: number;
  /** ISO timestamp of the last observed failure (or the error entry that started the streak). */
  lastFailureAt: string;
  /** ISO timestamp when the next resume becomes due. */
  nextAttemptAt: string | null;
  /** ISO timestamp when the module gave up; reset by an operator action. */
  exhaustedAt: string | null;
  /** ISO timestamp of the last automatic resume. */
  lastResumeAt: string | null;
  /**
   * myrmidon(OPE-11947): resumes issued in the current model-unavailable series
   * (absent or 0: no series). They do not count towards the attempt cap.
   */
  modelUnavailableResumes?: number;
  /**
   * myrmidon(1.6.6 AUTO-RESUME container): container starts tried in the current
   * "контейнер не поднят" series, written before each start. A successful start
   * replaces the whole state by the resume state, which drops this field.
   */
  containerStartFailures?: number;
  /** ISO time of the last container start attempt of that series. */
  lastContainerStartAt?: string;
}

function readIsoString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

export function readAutoResumeState(metadata: unknown): AutoResumeState | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[AUTO_RESUME_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const lastFailureAt = readIsoString(value.lastFailureAt);
  if (!lastFailureAt) return null;
  const failures = typeof value.failures === "number" && Number.isFinite(value.failures) && value.failures >= 0
    ? Math.floor(value.failures)
    : 0;
  return {
    failures,
    lastFailureAt,
    nextAttemptAt: readIsoString(value.nextAttemptAt),
    exhaustedAt: readIsoString(value.exhaustedAt),
    lastResumeAt: readIsoString(value.lastResumeAt),
    ...(typeof value.modelUnavailableResumes === "number" &&
    Number.isFinite(value.modelUnavailableResumes) &&
    value.modelUnavailableResumes > 0
      ? { modelUnavailableResumes: Math.floor(value.modelUnavailableResumes) }
      : {}),
    ...(typeof value.containerStartFailures === "number" &&
    Number.isFinite(value.containerStartFailures) &&
    value.containerStartFailures > 0 &&
    readIsoString(value.lastContainerStartAt)
      ? {
          containerStartFailures: Math.floor(value.containerStartFailures),
          lastContainerStartAt: readIsoString(value.lastContainerStartAt)!,
        }
      : {}),
  };
}

/** Merge the auto-resume state into an agent's metadata, preserving every other key. */
export function mergeAutoResumeState(metadata: unknown, state: AutoResumeState | null): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? { ...(metadata as Record<string, unknown>) }
    : {};
  if (state === null) {
    delete base[AUTO_RESUME_METADATA_KEY];
    return base;
  }
  base[AUTO_RESUME_METADATA_KEY] = state;
  return base;
}

export interface AutoResumeAttentionState {
  exhausted: boolean;
  failures: number;
  exhaustedAt: string | null;
}

/**
 * The slice of the auto-resume state the attention feed reads to escalate the
 * `agent_error_alert` card after the module gave up. Returns null when the
 * agent has no auto-resume state.
 */
export function readAutoResumeAttentionState(metadata: unknown): AutoResumeAttentionState | null {
  const state = readAutoResumeState(metadata);
  if (!state) return null;
  return { exhausted: Boolean(state.exhaustedAt), failures: state.failures, exhaustedAt: state.exhaustedAt };
}

export type AutoResumeDecisionAction = "skip" | "resume" | "exhaust" | "start_container";

export interface AutoResumeDecision {
  action: AutoResumeDecisionAction;
  reason: string;
  /** State to persist. Equals the incoming state when nothing changes. */
  nextState: AutoResumeState | null;
  /**
   * myrmidon(1.6.6 AUTO-RESUME container): only for `start_container`. `nextState` is the
   * attempt, recorded before the start as a failure; this is the state of the ordinary
   * resume that replaces it once the container is up and healthy.
   */
  stateAfterStart?: AutoResumeState;
}

export interface AutoResumePolicyAgent {
  status: string;
  errorReason?: string | null;
  /** `agents.updated_at`: the agent error entry (or the last operator/system touch). */
  updatedAt: Date;
}

/**
 * Pure policy: what to do with one agent on this tick. No I/O, so the backoff
 * steps, the attempt cap and the maintenance/pause gates are unit-testable.
 */
export function decideAutoResume(params: {
  agent: AutoResumePolicyAgent;
  state: AutoResumeState | null;
  settings: AutoResumeSettings;
  now: Date;
  invokable: boolean;
  underMaintenance: boolean;
  /**
   * myrmidon(OPE-11947): the agent's last finished run is model-unavailable
   * (`isModelUnavailableRun`); the agent returns on the long model-unavailable
   * schedule, outside the attempt cap.
   */
  lastRunModelUnavailable?: boolean;
  /** When that last finished run ended; the long schedule counts from it. */
  lastRunFinishedAt?: Date | null;
  /**
   * When an operator last resumed, updated or cleared this agent (a user
   * activity row), or null. Only an action after `exhaustedAt` re-arms a give-up.
   */
  lastOperatorActionAt?: Date | null;
  /**
   * myrmidon(1.6.6 AUTO-RESUME container): the sweep can start a bot container
   * (`AutoResumeSweeperDeps.startContainer`). Without it the reason "контейнер не
   * поднят" is skipped as before.
   */
  canStartContainer?: boolean;
}): AutoResumeDecision {
  const { agent, settings, now, invokable, underMaintenance } = params;
  const lastRunModelUnavailable = params.lastRunModelUnavailable ?? false;
  const lastOperatorActionAt = params.lastOperatorActionAt ?? null;
  let state = params.state;

  if (!settings.enabled) return { action: "skip", reason: "disabled", nextState: state };
  if (agent.status !== "error") return { action: "skip", reason: "not_error", nextState: state };
  // A paused, terminated or otherwise non-invokable agent must not be resumed;
  // the wake chain would refuse it anyway, so keep the sweep off that path.
  if (!invokable) return { action: "skip", reason: "not_invokable", nextState: state };
  if (underMaintenance) return { action: "skip", reason: "maintenance", nextState: state };

  // The gateway connect retries ran out and the agent was marked "контейнер не
  // поднят": resuming it onto a stopped container would only fail again, so the
  // container is started first (decideContainerStart); with no way to start one
  // the agent waits for the operator, as before.
  if (agent.errorReason === AUTO_RESUME_CONTAINER_NOT_STARTED_REASON) {
    if (!params.canStartContainer) {
      return { action: "skip", reason: "container_not_started", nextState: state };
    }
    return decideContainerStart({
      agent,
      state,
      settings,
      now,
      lastOperatorActionAt: params.lastOperatorActionAt ?? null,
    });
  }

  // myrmidon(OPE-11947): the model pool could not answer the last run. Resuming
  // wakes every task the agent is stranded on, and each new run fails on the
  // same quota, so the agent returns on the long model-unavailable schedule
  // (30 min, 1 h, 2 h, 4 h, then every 6 h after that run ended). These resumes
  // are outside the attempt cap and never give up: the quota resets some day.
  let modelUnavailableResumes = state?.modelUnavailableResumes ?? 0;
  if (lastRunModelUnavailable) {
    const lastRunFinishedAtMs = (params.lastRunFinishedAt ?? agent.updatedAt).getTime();
    const lastResumeAtMs = state?.lastResumeAt ? Date.parse(state.lastResumeAt) : Number.NaN;
    // A series continues only while the failing run followed the last resume
    // closely; a run that ended much later, after a healthy stretch, starts over.
    if (
      modelUnavailableResumes > 0 &&
      Number.isFinite(lastResumeAtMs) &&
      lastRunFinishedAtMs - lastResumeAtMs > MODEL_UNAVAILABLE_RETRY_MAX_DELAY_MS
    ) {
      modelUnavailableResumes = 0;
    }
    // Never sooner than one step after the last resume either, whatever the run's age.
    const baseMs =
      modelUnavailableResumes > 0 && Number.isFinite(lastResumeAtMs)
        ? Math.max(lastRunFinishedAtMs, lastResumeAtMs)
        : lastRunFinishedAtMs;
    const dueAtMs = baseMs + computeModelUnavailableRetryDelayMs(modelUnavailableResumes + 1);
    if (now.getTime() < dueAtMs) {
      return { action: "skip", reason: "model_unavailable_wait", nextState: state };
    }
    const nextResumes = modelUnavailableResumes + 1;
    return {
      action: "resume",
      reason: "model_unavailable_due",
      nextState: {
        // The ordinary streak is not touched by the quota: it starts clean once the model is back.
        failures: 0,
        lastFailureAt: now.toISOString(),
        nextAttemptAt: null,
        exhaustedAt: null,
        lastResumeAt: now.toISOString(),
        modelUnavailableResumes: nextResumes,
      },
    };
  }
  // The last run is not model-unavailable (the model is back, or the error is another one):
  // the series is over and the ordinary 1/5/15 min backoff with its cap applies again.
  if (modelUnavailableResumes > 0) state = null;

  // Re-arm after an operator acted: a resume, update or error clear by a user
  // after we gave up is a new episode and the attempt counter starts over.
  // `agents.updated_at` is deliberately not read: runs and status changes move
  // it, which re-armed a give-up a few minutes after it was written.
  if (state?.exhaustedAt) {
    const exhaustedAtMs = Date.parse(state.exhaustedAt);
    if (Number.isFinite(exhaustedAtMs) && lastOperatorActionAt && lastOperatorActionAt.getTime() > exhaustedAtMs) {
      state = null;
    }
  }

  // A streak older than the window is not one streak: start fresh.
  if (state && !state.exhaustedAt) {
    const lastFailureAtMs = Date.parse(state.lastFailureAt);
    if (!Number.isFinite(lastFailureAtMs) || now.getTime() - lastFailureAtMs > settings.failureWindowMs) {
      state = null;
    }
  }

  if (state?.exhaustedAt) return { action: "skip", reason: "exhausted", nextState: state };

  const failures = state?.failures ?? 0;
  if (failures >= settings.maxAttempts) {
    return {
      action: "exhaust",
      reason: "max_attempts",
      nextState: {
        failures,
        lastFailureAt: state?.lastFailureAt ?? agent.updatedAt.toISOString(),
        nextAttemptAt: state?.nextAttemptAt ?? null,
        exhaustedAt: now.toISOString(),
        lastResumeAt: state?.lastResumeAt ?? null,
      },
    };
  }

  const lastFailureAtMs = state ? Date.parse(state.lastFailureAt) : agent.updatedAt.getTime();
  const dueAtMs = lastFailureAtMs + backoffForAttempt(settings.backoffMs, failures);
  if (Number.isFinite(dueAtMs) && now.getTime() < dueAtMs) {
    return { action: "skip", reason: "not_due", nextState: state };
  }

  const nextFailures = failures + 1;
  return {
    action: "resume",
    reason: "due",
    nextState: {
      failures: nextFailures,
      lastFailureAt: now.toISOString(),
      nextAttemptAt: new Date(now.getTime() + backoffForAttempt(settings.backoffMs, nextFailures)).toISOString(),
      exhaustedAt: null,
      lastResumeAt: now.toISOString(),
    },
  };
}

/**
 * myrmidon(1.6.6 AUTO-RESUME container): the policy for an agent in `error` with the reason
 * "контейнер не поднят". Pure, like `decideAutoResume`.
 *
 *  - The first start is tried at once: the run retries that ended in this error are spent.
 *  - A start that failed is retried no sooner than 15 minutes after the previous attempt, 4
 *    attempts in all; then `exhaust`, which raises the ordinary operator card.
 *  - After a healthy start the agent is resumed like any other (`stateAfterStart`); such a
 *    resume counts in the ordinary streak, so a container that starts and still refuses the
 *    gateway ends in the ordinary give-up as well.
 *  - A give-up is re-armed only by an operator action, exactly as in the ordinary path.
 */
function decideContainerStart(params: {
  agent: AutoResumePolicyAgent;
  state: AutoResumeState | null;
  settings: AutoResumeSettings;
  now: Date;
  lastOperatorActionAt: Date | null;
}): AutoResumeDecision {
  const { agent, settings, now, lastOperatorActionAt } = params;
  const nowMs = now.getTime();
  let state = params.state;

  if (state?.exhaustedAt) {
    const exhaustedAtMs = Date.parse(state.exhaustedAt);
    if (Number.isFinite(exhaustedAtMs) && lastOperatorActionAt && lastOperatorActionAt.getTime() > exhaustedAtMs) {
      state = null;
    }
  }
  if (state?.exhaustedAt) return { action: "skip", reason: "exhausted", nextState: state };

  // Resumes after a healthy start that failed again: the ordinary streak and its cap.
  const lastResumeAtMs = state?.lastResumeAt ? Date.parse(state.lastResumeAt) : Number.NaN;
  const streakFailures =
    state && Number.isFinite(lastResumeAtMs) && nowMs - lastResumeAtMs <= settings.failureWindowMs ? state.failures : 0;
  if (streakFailures >= settings.maxAttempts) {
    return {
      action: "exhaust",
      reason: "max_attempts",
      nextState: {
        failures: streakFailures,
        lastFailureAt: state?.lastFailureAt ?? agent.updatedAt.toISOString(),
        nextAttemptAt: state?.nextAttemptAt ?? null,
        exhaustedAt: now.toISOString(),
        lastResumeAt: state?.lastResumeAt ?? null,
      },
    };
  }

  const lastStartAtMs = state?.lastContainerStartAt ? Date.parse(state.lastContainerStartAt) : Number.NaN;
  const seriesAlive =
    Number.isFinite(lastStartAtMs) && nowMs - lastStartAtMs <= AUTO_RESUME_CONTAINER_START_SERIES_WINDOW_MS;
  const startFailures = seriesAlive ? (state?.containerStartFailures ?? 0) : 0;
  if (startFailures >= AUTO_RESUME_CONTAINER_START_MAX_ATTEMPTS) {
    return {
      action: "exhaust",
      reason: "container_start_failed",
      nextState: {
        // The card says "gave up after N attempt(s)": N is the container starts tried.
        failures: startFailures,
        lastFailureAt: state?.lastFailureAt ?? now.toISOString(),
        nextAttemptAt: null,
        exhaustedAt: now.toISOString(),
        lastResumeAt: state?.lastResumeAt ?? null,
      },
    };
  }
  if (startFailures > 0 && nowMs < lastStartAtMs + AUTO_RESUME_CONTAINER_START_RETRY_MS) {
    return { action: "skip", reason: "container_start_wait", nextState: state };
  }

  return {
    action: "start_container",
    reason: "container_not_started",
    // Written before the start, as a failure: a crash or an overlapping pass must not repeat it.
    nextState: {
      failures: streakFailures,
      lastFailureAt: now.toISOString(),
      nextAttemptAt: new Date(nowMs + AUTO_RESUME_CONTAINER_START_RETRY_MS).toISOString(),
      exhaustedAt: null,
      lastResumeAt: state?.lastResumeAt ?? null,
      containerStartFailures: startFailures + 1,
      lastContainerStartAt: now.toISOString(),
    },
    stateAfterStart: {
      failures: streakFailures + 1,
      lastFailureAt: now.toISOString(),
      nextAttemptAt: new Date(nowMs + backoffForAttempt(settings.backoffMs, streakFailures + 1)).toISOString(),
      exhaustedAt: null,
      lastResumeAt: now.toISOString(),
    },
  };
}

export interface AutoResumeActivityInput {
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

export interface AutoResumeSweeperDeps {
  db: Db;
  /** Existing wake chain for a resumed agent (`heartbeat.resumeAgentAfterPause`). */
  resumeWake: (agentId: string) => Promise<unknown>;
  /** Invokability check for one agent (false for paused/terminated/broken chain). */
  isAgentInvokable: (agent: {
    id: string;
    companyId: string;
    name: string;
    reportsTo: string | null;
    status: string;
  }) => Promise<boolean>;
  /** Maintenance-mode gate (myrmidon R3): agents in a window are not resumed. */
  isAgentUnderMaintenance: (agentId: string) => Promise<boolean>;
  /** Optional activity log; absent in unit tests. */
  logActivity?: (input: AutoResumeActivityInput) => Promise<void>;
  /**
   * myrmidon(TEAM-LIVENESS-SETTINGS): the effective knobs, read once per pass so
   * a save on the instance settings page takes effect without a restart. Absent
   * (unit tests that predate the settings area) means the environment decides.
   */
  readLiveness?: () => Promise<ResolvedTeamLiveness>;
  /**
   * myrmidon(1.6.6 AUTO-RESUME container): starts the agent's bot container through the
   * board's own path and resolves once it is running and healthy; throws otherwise (the
   * wiring uses `IdleStopService.ensureStartedAndHealthy`, the same call that starts an
   * idle-stopped container before a run). Absent: an agent whose reason is "контейнер не
   * поднят" is skipped as before.
   */
  startContainer?: (agentId: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface AutoResumeSweepResult {
  agentsChecked: number;
  resumed: number;
  exhausted: number;
  skipped: number;
  /** Agents that received an automatic resume this pass. */
  agentIds: string[];
}

const AUTO_RESUME_RESULT_ZERO: Omit<AutoResumeSweepResult, "agentIds"> = {
  agentsChecked: 0,
  resumed: 0,
  exhausted: 0,
  skipped: 0,
};

/** A fresh zero result; a bare spread would share the agentIds array across calls. */
function emptyAutoResumeResult(): AutoResumeSweepResult {
  return { ...AUTO_RESUME_RESULT_ZERO, agentIds: [] };
}

interface AutoResumeAgentRow {
  id: string;
  companyId: string;
  name: string;
  reportsTo: string | null;
  status: string;
  errorReason: string | null;
  updatedAt: Date;
  metadata: Record<string, unknown> | null;
  /** myrmidon(TEAM-LIVENESS-SETTINGS): the card the per-agent switch lives on. */
  adapterConfig?: unknown;
}

/**
 * Flips an errored agent back to idle and records the next streak state in the
 * same conditional update. Only the agent that still sits in `error` is
 * claimed, so a concurrent resume (an operator, another tick) cannot double
 * fire. The caller issues the wake chain only when this returns true.
 */
async function claimAutoResume(db: Db, agent: AutoResumeAgentRow, nextState: AutoResumeState, now: Date): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({
      status: "idle",
      errorReason: null,
      pauseReason: null,
      pausedAt: null,
      updatedAt: now,
      metadata: mergeAutoResumeState(agent.metadata, nextState),
    })
    .where(and(eq(agents.id, agent.id), eq(agents.status, "error")))
    .returning({ id: agents.id });
  return Boolean(rows[0]);
}

/**
 * Marks the agent as given up: writes `exhaustedAt` and deliberately leaves
 * `updated_at` untouched, so the give-up does not look like a fresh error entry.
 */
async function markAutoResumeExhausted(
  db: Db,
  agent: AutoResumeAgentRow,
  nextState: AutoResumeState,
): Promise<boolean> {
  return writeAutoResumeStateKeepingUpdatedAt(db, agent, nextState);
}

/**
 * Writes the state of an agent that stays in `error`, leaving `updated_at` untouched (it is
 * the error entry the ordinary backoff counts from). Only an agent still in `error` is written.
 */
async function writeAutoResumeStateKeepingUpdatedAt(
  db: Db,
  agent: AutoResumeAgentRow,
  nextState: AutoResumeState,
): Promise<boolean> {
  const rows = await db
    .update(agents)
    .set({ metadata: mergeAutoResumeState(agent.metadata, nextState) })
    .where(and(eq(agents.id, agent.id), eq(agents.status, "error")))
    .returning({ id: agents.id });
  return Boolean(rows[0]);
}

/**
 * myrmidon(1.6.6 AUTO-RESUME container): the agent's row as the sweep reads it, fetched again
 * after a container start, which can take minutes (the metadata may have moved meanwhile).
 */
async function readAutoResumeAgentRow(db: Db, agentId: string): Promise<AutoResumeAgentRow | null> {
  const rows = (await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
      errorReason: agents.errorReason,
      updatedAt: agents.updatedAt,
      metadata: agents.metadata,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)) as AutoResumeAgentRow[];
  return rows[0] ?? null;
}

/**
 * myrmidon(OPE-11947): whether the agent's last finished run is model-unavailable,
 * and when it ended. Newest run by creation time (the company/agent/created index), skipping runs
 * that have not finished (queued, running, a scheduled retry waiting its time).
 */
async function readLastRunModelUnavailable(
  db: Db,
  agent: AutoResumeAgentRow,
): Promise<{ modelUnavailable: boolean; finishedAt: Date | null }> {
  const rows = await db
    .select({ resultJson: heartbeatRuns.resultJson, finishedAt: heartbeatRuns.finishedAt })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, agent.companyId),
        eq(heartbeatRuns.agentId, agent.id),
        isNotNull(heartbeatRuns.finishedAt),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  const last = rows[0];
  return { modelUnavailable: last ? isModelUnavailableRun(last) : false, finishedAt: last?.finishedAt ?? null };
}

/**
 * myrmidon(OPE-11947): the newest operator action on this agent after `since`
 * (a user's `agent.resumed` / `agent.updated` / `agent.error_cleared` row), or
 * null. `entity_id` is the agent acted on; `agent_id` would be the acting agent.
 */
async function readLastOperatorActionAt(db: Db, agent: AutoResumeAgentRow, since: Date): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.entityType, "agent"),
        eq(activityLog.entityId, agent.id),
        eq(activityLog.companyId, agent.companyId),
        eq(activityLog.actorType, "user"),
        inArray(activityLog.action, [...AUTO_RESUME_OPERATOR_ACTIVITY_ACTIONS]),
        gt(activityLog.createdAt, since),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  return rows[0]?.createdAt ?? null;
}

export interface AutoResumeSweeper {
  sweep(now?: Date): Promise<AutoResumeSweepResult>;
  resetForTest(): void;
}

/**
 * The scheduler-tick pass: resumes every errored agent whose backoff step is
 * due, at most once per `MYRMIDON_AUTO_RESUME_INTERVAL_SEC` seconds. The tick
 * handler owns the timer; this only remembers the last pass. Single-flight is
 * the caller's job (the sweep queue in `server/src/index.ts`).
 */
/** The agent row's card as a plain object; anything else reads as an empty card. */
function readAgentCard(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function createAutoResumeSweeper(deps: AutoResumeSweeperDeps): AutoResumeSweeper {
  let lastSweepAtMs = 0;
  return {
    resetForTest() {
      lastSweepAtMs = 0;
    },
    async sweep(now = new Date()): Promise<AutoResumeSweepResult> {
      const env = deps.env ?? process.env;
      const settings = readAutoResumeSettings(env);
      // myrmidon(TEAM-LIVENESS-SETTINGS): stored instance settings beat the
      // environment; the reader resolved that precedence per key already.
      const liveness = deps.readLiveness ? (await deps.readLiveness()).settings : null;
      const enabled = liveness ? liveness.autoResumeEnabled : settings.enabled;
      if (!enabled) return emptyAutoResumeResult();
      if (now.getTime() - lastSweepAtMs < settings.intervalSec * 1000) return emptyAutoResumeResult();
      lastSweepAtMs = now.getTime();

      const rows = (await deps.db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          reportsTo: agents.reportsTo,
          status: agents.status,
          errorReason: agents.errorReason,
          updatedAt: agents.updatedAt,
          metadata: agents.metadata,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .innerJoin(companies, eq(companies.id, agents.companyId))
        .where(and(eq(companies.status, "active"), eq(agents.status, "error")))) as AutoResumeAgentRow[];

      const result = emptyAutoResumeResult();

      // The wake chain and the activity row of one automatic resume, after the agent
      // was claimed (flipped to idle); shared by the ordinary resume and by the resume
      // that follows a healthy container start.
      const finishResume = async (
        agent: AutoResumeAgentRow,
        nextState: AutoResumeState,
        extraDetails: Record<string, unknown>,
      ): Promise<void> => {
        try {
          await deps.resumeWake(agent.id);
        } catch (err) {
          // Best-effort: the agent is already back to idle; the next tick sees
          // it as idle and stops, and a stranded wake is retried by the other
          // resume paths (pause-drain, stranded recovery).
          logger.warn({ err, agentId: agent.id }, "auto-resume wake failed after an automatic resume");
        }
        result.resumed += 1;
        result.agentIds.push(agent.id);
        await deps.logActivity?.({
          companyId: agent.companyId,
          actorType: "system",
          actorId: AUTO_RESUME_ACTOR_ID,
          agentId: agent.id,
          runId: null,
          action: AUTO_RESUME_ACTIVITY_ACTION,
          entityType: "agent",
          entityId: agent.id,
          details: {
            attempt: nextState.failures,
            errorReason: agent.errorReason,
            nextAttemptAt: nextState.nextAttemptAt,
            ...extraDetails,
          },
        });
      };

      // myrmidon(1.6.6 AUTO-RESUME container): one attempt to bring the bot container up
      // for an agent left in "контейнер не поднят", then the ordinary resume. The attempt
      // is written first (a failure until proven otherwise), so a crash or an overlapping
      // pass cannot repeat it; a start can take minutes, so these run beside the other agents.
      const startContainerAndResume = async (agent: AutoResumeAgentRow, decision: AutoResumeDecision): Promise<void> => {
        const attemptState = decision.nextState!;
        const attempt = attemptState.containerStartFailures ?? 1;
        try {
          if (!(await writeAutoResumeStateKeepingUpdatedAt(deps.db, agent, attemptState))) {
            result.skipped += 1;
            return;
          }
          try {
            await deps.startContainer!(agent.id);
          } catch (err) {
            logger.warn({ err, agentId: agent.id, attempt }, "auto-resume: the bot container did not start");
            await deps.logActivity?.({
              companyId: agent.companyId,
              actorType: "system",
              actorId: AUTO_RESUME_ACTOR_ID,
              agentId: agent.id,
              runId: null,
              action: AUTO_RESUME_CONTAINER_START_FAILED_ACTIVITY_ACTION,
              entityType: "agent",
              entityId: agent.id,
              details: {
                attempt,
                maxAttempts: AUTO_RESUME_CONTAINER_START_MAX_ATTEMPTS,
                nextAttemptAt: attempt >= AUTO_RESUME_CONTAINER_START_MAX_ATTEMPTS ? null : attemptState.nextAttemptAt,
                error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
              },
            });
            result.skipped += 1;
            return;
          }
          // The container is up and healthy. The start could take minutes: read the row
          // again, and resume only an agent that still sits in `error`.
          const fresh = await readAutoResumeAgentRow(deps.db, agent.id);
          if (!fresh || fresh.status !== "error") {
            result.skipped += 1;
            return;
          }
          if (!(await claimAutoResume(deps.db, fresh, decision.stateAfterStart!, now))) {
            result.skipped += 1;
            return;
          }
          await finishResume(fresh, decision.stateAfterStart!, { containerStarted: true, containerStartAttempt: attempt });
        } catch (err) {
          logger.warn({ err, agentId: agent.id }, "auto-resume: container start pass failed");
          result.skipped += 1;
        }
      };
      const containerStarts: Promise<void>[] = [];

      for (const agent of rows) {
        result.agentsChecked += 1;
        // myrmidon(TEAM-LIVENESS-SETTINGS): this agent's own switch. A card that
        // turned auto-resume off keeps its `error` state for an operator to
        // decide; an absent switch means the instance value applies.
        if (liveness && !resolveAgentTeamLiveness(readAgentCard(agent.adapterConfig), liveness).autoResumeEnabled) {
          result.skipped += 1;
          continue;
        }
        const invokable = await deps.isAgentInvokable(agent);
        const underMaintenance = await deps.isAgentUnderMaintenance(agent.id);
        const state = readAutoResumeState(agent.metadata);
        // myrmidon(OPE-11947): the two facts the policy reads from the database.
        const lastRun = await readLastRunModelUnavailable(deps.db, agent);
        const exhaustedAt = state?.exhaustedAt ? new Date(state.exhaustedAt) : null;
        const lastOperatorActionAt =
          exhaustedAt && Number.isFinite(exhaustedAt.getTime())
            ? await readLastOperatorActionAt(deps.db, agent, exhaustedAt)
            : null;
        const decision = decideAutoResume({
          agent: {
            status: agent.status,
            errorReason: agent.errorReason,
            updatedAt: agent.updatedAt,
          },
          state,
          settings,
          now,
          invokable,
          underMaintenance,
          lastRunModelUnavailable: lastRun.modelUnavailable,
          lastRunFinishedAt: lastRun.finishedAt,
          lastOperatorActionAt,
          canStartContainer: Boolean(deps.startContainer),
        });

        if (decision.action === "skip") {
          result.skipped += 1;
          continue;
        }

        if (decision.action === "exhaust") {
          const marked = await markAutoResumeExhausted(deps.db, agent, decision.nextState!);
          if (!marked) {
            result.skipped += 1;
            continue;
          }
          result.exhausted += 1;
          await deps.logActivity?.({
            companyId: agent.companyId,
            actorType: "system",
            actorId: AUTO_RESUME_ACTOR_ID,
            agentId: agent.id,
            runId: null,
            action: AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION,
            entityType: "agent",
            entityId: agent.id,
            details: {
              attempts: decision.nextState!.failures,
              errorReason: agent.errorReason,
              reason: decision.reason,
            },
          });
          continue;
        }

        if (decision.action === "start_container") {
          containerStarts.push(startContainerAndResume(agent, decision));
          continue;
        }

        const claimed = await claimAutoResume(deps.db, agent, decision.nextState!, now);
        if (!claimed) {
          result.skipped += 1;
          continue;
        }
        await finishResume(
          agent,
          decision.nextState!,
          // myrmidon(OPE-11947): a long-schedule resume is not an attempt of the capped streak.
          decision.reason === "model_unavailable_due"
            ? { modelUnavailable: true, modelUnavailableResumes: decision.nextState!.modelUnavailableResumes }
            : {},
        );
      }
      // The container starts ran beside the loop above; the pass ends when they have.
      await Promise.all(containerStarts);

      if (result.resumed > 0 || result.exhausted > 0) {
        logger.warn(
          { resumed: result.resumed, exhausted: result.exhausted, agentIds: result.agentIds },
          "auto-resume swept errored agents",
        );
      }
      return result;
    },
  };
}

/**
 * 24 h metric for the health page (part E): how many automatic resumes the
 * board issued for a company since the given instant. Reads the activity log,
 * so it survives a restart.
 */
export async function countAutoResumesSince(db: Db, companyId: string, since: Date): Promise<number> {
  return countActivitySince(db, companyId, AUTO_RESUME_ACTIVITY_ACTION, since);
}

/** How many agents the board gave up auto-resuming for a company since the given instant. */
export async function countAutoResumeExhaustionsSince(db: Db, companyId: string, since: Date): Promise<number> {
  return countActivitySince(db, companyId, AUTO_RESUME_EXHAUSTED_ACTIVITY_ACTION, since);
}

export interface AutoResumeMetrics {
  autoResumes: number;
  exhaustions: number;
}

/** Both counts in one call, for a health-page block that wants the pair. */
export async function autoResumeMetrics(
  db: Db,
  companyId: string,
  since: Date,
): Promise<AutoResumeMetrics> {
  const [autoResumes, exhaustions] = await Promise.all([
    countAutoResumesSince(db, companyId, since),
    countAutoResumeExhaustionsSince(db, companyId, since),
  ]);
  return { autoResumes, exhaustions };
}

async function countActivitySince(db: Db, companyId: string, action: string, since: Date): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, action),
        gte(activityLog.createdAt, since),
      ),
    );
  return rows[0]?.count ?? 0;
}