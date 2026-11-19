// myrmidon(RUN-GUARD-LOOPS): what the board does after the run guard stopped a run.
//
// A run the guard stops (model call limit, idle timeout, tool retry loop,
// read-only exploration without a write, the same read repeated) stopped
// because of what the agent did with this task. A retry sends the same task
// and context to the same agent, repeats the behaviour and burns the same
// tokens again, so the board does not retry such a run. The issue goes to
// `blocked` through the stranded-recovery escalation with a comment that says
// why and what is needed (a new input: clarify or split the task).
//
// One stop is not final: `model_call_limit` also trips on productive work. A
// run that hit the call limit after making changes (patch, write_file, a
// terminal command that writes: `writeCalls` in the guard statistics) is a run
// that was working, not looping, so the board continues it the way it continues
// a run that ran out of turns (RUN-GUARD-CONTINUE). These continuations have
// their own ceiling (`heartbeat.runGuardContinuation.maxAttempts`, default 6,
// at most 20) and do not spend the max-turn ceiling
// (`heartbeat.maxTurnContinuation.maxAttempts`): a chain of productive runs of
// 150 calls each is not a loop. When the own ceiling is spent, or the last run
// changed nothing, the stop is final again.
//
// This module holds the pure parts: recognising a guard-stopped run, whether it
// continues, and the comment text. The wiring is in services/heartbeat.ts (stop
// handling and the retry scheduler) and services/recovery/service.ts (the
// stranded sweep).

import { isRunGuardStopReason, type RunGuardStopReason } from "@myrmidon/adapter-utils/run-guard";

interface RunGuardStopRunShape {
  errorCode?: string | null;
  resultJson?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The guard stop reason a run was stopped with, or null for any other run. */
export function readRunGuardStopReason(run: RunGuardStopRunShape | null | undefined): RunGuardStopReason | null {
  if (!run) return null;
  if (isRunGuardStopReason(run.errorCode)) return run.errorCode;
  const persisted = asRecord(run.resultJson)?.runGuardStopReason;
  return isRunGuardStopReason(persisted) ? persisted : null;
}

/** Short Russian reason shown in the issue comment. */
const REASON_LABELS: Record<RunGuardStopReason, string> = {
  model_call_limit: "лимит вызовов модели",
  idle_timeout: "нет активности",
  tool_retry_loop: "повтор неудачного вызова инструмента",
  no_progress_exploration: "только чтение без изменений",
  repeated_tool_call: "повтор одного и того же вызова",
};

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Russian plural of "вызов" for a count. */
function callsWord(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "вызовов";
  if (last === 1) return "вызов";
  if (last >= 2 && last <= 4) return "вызова";
  return "вызовов";
}

/** Guard statistics at the moment of the stop (`RunGuard.stats()`). */
export interface RunGuardStopStats {
  readOnlyStreak?: number;
  modelCalls?: number;
  /** Calls that were not read-only (myrmidon(RUN-GUARD-CONTINUE)). */
  writeCalls?: number;
}

/**
 * How many calls that change something the stopped run made, from the guard
 * statistics (passed in, or stored by heartbeat next to the stop reason).
 * 0 when unknown: a run stored before the counter existed, or one whose adapter
 * does not feed the guard tool calls.
 */
export function readRunGuardWriteCalls(
  run: RunGuardStopRunShape | null | undefined,
  statsOverride?: RunGuardStopStats | null,
): number {
  const stats = statsOverride ?? asRecord(asRecord(run?.resultJson)?.runGuardStats);
  return readCount(stats?.writeCalls);
}

export const NO_PROGRESS_AUTO_RETRY_HINT =
  "Предыдущий прогон остановлен: много чтений без записи. Перейди к записи (правка кода, тест, коммит) или опиши блокер в комментарии.";

/**
 * True when a guard stop is not final:
 * 1. The call limit tripped on a run that made changes.
 * 2. myrmidon(OPE-12004): `no_progress_exploration` gets one automatic retry with a hint.
 * Loops (`repeated_tool_call`, `tool_retry_loop`, `idle_timeout`) and a call-limit
 * stop without a single change stay final: another run would repeat the same behaviour.
 */
export function shouldContinueAfterRunGuardStop(
  run: RunGuardStopRunShape | null | undefined,
  stats?: RunGuardStopStats | null,
): boolean {
  const reason = readRunGuardStopReason(run);
  if (reason === "model_call_limit" && readRunGuardWriteCalls(run, stats) > 0) {
    return true;
  }
  if (reason === "no_progress_exploration") {
    return true;
  }
  return false;
}

// myrmidon(OPE-12799): the second empty stop in a row is final.
//
// `writeCalls` > 0 does not say the run produced anything: on 11-12.11 every run
// stopped at the call limit had 34..150 "write" calls, and 23 of 32 engineer runs
// left nothing on the board (no commit, no comment, no document). Each was
// continued as productive, up to six times along a chain, and a wake of another
// kind (idle pickup, monitor, maintenance retry) started the count over. So the
// continuation is also judged by what the run left on the board, and the count
// is by issue and agent, not by retry chain.

/** The stops that come from the amount of work without a result: the two limits. */
export function isRunGuardLimitStopReason(reason: RunGuardStopReason | null | undefined): boolean {
  return reason === "model_call_limit" || reason === "no_progress_exploration";
}

/** How far back a previous empty stop of the same issue still counts. */
export const RUN_GUARD_EMPTY_STOP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** How many previous runs of the issue are looked at. */
export const RUN_GUARD_EMPTY_STOP_LOOKBACK_RUNS = 10;

/** What a run left on the board (a subset of the run liveness evidence). */
export interface RunGuardOutcomeEvidence {
  issueCommentsCreated?: number | null;
  documentRevisionsCreated?: number | null;
  workProductsCreated?: number | null;
}

/**
 * True when the run left something on the board that the next run and the lead
 * can see: a comment, a document revision (not the continuation summary, which
 * the board writes itself), a work product (commit, branch, pull request,
 * artifact). Tool calls do not count: they are not a result.
 */
export function runHasUsefulOutcome(evidence: RunGuardOutcomeEvidence | null | undefined): boolean {
  if (!evidence) return false;
  return (
    readCount(evidence.issueCommentsCreated) > 0 ||
    readCount(evidence.documentRevisionsCreated) > 0 ||
    readCount(evidence.workProductsCreated) > 0
  );
}

/**
 * The previous limit stop of the same issue and agent, from the previous runs
 * that started, newest first; null when the run before was not one. Runs that
 * say nothing about the task (transport failures, maintenance interruptions,
 * cancellations) are skipped. A run that succeeded, or a guard stop of another
 * kind (final on its own), ends the search: the stops are not in a row.
 */
export function findPreviousLimitStopRun<T extends RunGuardStopRunShape & { status?: string | null }>(
  previousRuns: readonly T[],
): T | null {
  for (const previous of previousRuns) {
    const reason = readRunGuardStopReason(previous);
    if (reason) return isRunGuardLimitStopReason(reason) ? previous : null;
    if (previous.status === "succeeded") return null;
  }
  return null;
}

/**
 * True when this limit stop is the second in a row for the issue without a
 * result: the run left nothing on the board, and neither did the previous limit
 * stop. Such a stop is final whatever `writeCalls` says and whatever ceiling
 * the retry chain has left.
 */
export function isRepeatedEmptyLimitStop(input: {
  run: RunGuardStopRunShape | null | undefined;
  runHasUsefulOutcome: boolean;
  /** null when the run before was not a limit stop (findPreviousLimitStopRun). */
  previousLimitStop: { hasUsefulOutcome: boolean } | null;
}): boolean {
  if (!isRunGuardLimitStopReason(readRunGuardStopReason(input.run))) return false;
  if (input.runHasUsefulOutcome) return false;
  return input.previousLimitStop !== null && !input.previousLimitStop.hasUsefulOutcome;
}

/**
 * myrmidon(OPE-12799): what the continuation of a call-limit stop is told. The
 * session may be fresh (a `run` or `none` strategy, or a reset), so the run would
 * otherwise start the task over.
 */
export const CALL_LIMIT_CONTINUATION_HINT =
  "Предыдущий прогон этой задачи остановлен по лимиту вызовов модели и не дошёл до конца. Не начинай задачу заново. " +
  "Сначала посмотри, что уже сделано: последние комментарии задачи, ветку задачи (git status, git log, git diff в рабочей копии и на origin). " +
  "Продолжи с этого места. Рано закоммить и запушь сделанное и напиши в комментарии, что готово и что осталось: " +
  "прогон ограничен по числу вызовов, а следующий увидит только запушенное и комментарий.";

/** Default ceiling of call-limit continuations along one chain (RUN-GUARD-CONTINUE). */
export const RUN_GUARD_CONTINUATION_DEFAULT_MAX_ATTEMPTS = 6;
/** Upper bound of `heartbeat.runGuardContinuation.maxAttempts`, whatever the agent config says. */
export const RUN_GUARD_CONTINUATION_MAX_ATTEMPTS_CAP = 20;
/**
 * Run context key that counts the call-limit continuations already made along the
 * chain. Retries copy the run context, so the count travels with the chain; the
 * shared chain counter (`scheduledRetryAttempt`) also counts max-turn continuations,
 * which is why the two ceilings are told apart by this key.
 */
export const RUN_GUARD_CONTINUATION_CONTEXT_KEY = "runGuardContinuationAttempts";

export interface RunGuardContinuationPolicy {
  enabled: boolean;
  maxAttempts: number;
}

/**
 * The call-limit continuation policy of an agent: `runtimeConfig.heartbeat.runGuardContinuation`
 * (`enabled`, default true; `maxAttempts`, default 6, clamped to 0..20; 0 turns it off).
 */
export function parseRunGuardContinuationPolicy(runtimeConfig: unknown): RunGuardContinuationPolicy {
  const configured = asRecord(asRecord(asRecord(runtimeConfig)?.heartbeat)?.runGuardContinuation);
  const raw = configured?.maxAttempts;
  const maxAttempts =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.floor(raw)
      : RUN_GUARD_CONTINUATION_DEFAULT_MAX_ATTEMPTS;
  return {
    enabled: typeof configured?.enabled === "boolean" ? configured.enabled : true,
    maxAttempts: Math.max(0, Math.min(RUN_GUARD_CONTINUATION_MAX_ATTEMPTS_CAP, maxAttempts)),
  };
}

/** How many call-limit continuations the chain of this run has already made (0 for a run outside one). */
export function readRunGuardContinuationCount(run: { contextSnapshot?: unknown } | null | undefined): number {
  return readCount(asRecord(run?.contextSnapshot)?.[RUN_GUARD_CONTINUATION_CONTEXT_KEY]);
}

/**
 * The ceiling to hand the retry scheduler for the next call-limit continuation, or
 * null when the chain has spent its own ceiling. The scheduler counts along the shared
 * chain counter (`scheduledRetryAttempt` of the stopped run), so the ceiling is that
 * counter plus what is left of the own ceiling.
 */
export function runGuardContinuationSchedulerCeiling(input: {
  scheduledRetryAttempt: number | null | undefined;
  continuationsMade: number;
  maxAttempts: number;
}): number | null {
  const left = input.maxAttempts - input.continuationsMade;
  if (left <= 0) return null;
  return readCount(input.scheduledRetryAttempt) + left;
}

/**
 * The ceiling to hand the retry scheduler for the next max-turn continuation: the
 * policy ceiling plus the call-limit continuations of the chain, which share the
 * chain counter but do not spend this ceiling.
 */
export function maxTurnContinuationSchedulerCeiling(
  policyMaxAttempts: number,
  run: { contextSnapshot?: unknown } | null | undefined,
): number {
  return policyMaxAttempts + readRunGuardContinuationCount(run);
}

/**
 * The calls the stopped run made, from the guard statistics (passed in, or
 * stored by heartbeat next to the stop reason): the read-only streak (calls
 * without a write) when there is one, else the model calls.
 */
function describeCalls(run: RunGuardStopRunShape, statsOverride?: RunGuardStopStats | null): string | null {
  const stats = statsOverride ?? asRecord(asRecord(run.resultJson)?.runGuardStats);
  const readOnly = readCount(stats?.readOnlyStreak);
  if (readOnly > 0) return `${readOnly} ${callsWord(readOnly)} без записи`;
  const modelCalls = readCount(stats?.modelCalls);
  if (modelCalls > 0) return `${modelCalls} ${callsWord(modelCalls)} модели`;
  return null;
}

export const RUN_GUARD_STOP_NOTICE_TITLE = "Прогон остановлен защитой";
export const RUN_GUARD_STOP_NOTICE_NEXT_ACTION =
  "Дать исполнителю новую вводную: уточнить задачу или разбить её на части, затем вернуть в работу.";

/** The issue comment for a guard-stopped run, or null when the run was not guard-stopped. */
export function buildRunGuardStopComment(
  run: RunGuardStopRunShape | null | undefined,
  stats?: RunGuardStopStats | null,
  opts?: { repeatedEmpty?: boolean },
): string | null {
  const reason = readRunGuardStopReason(run);
  if (!reason || !run) return null;
  const calls = describeCalls(run, stats);
  // myrmidon(OPE-12799): the second limit stop in a row without a result.
  if (opts?.repeatedEmpty) {
    return (
      `Второй прогон подряд остановлен защитой без результата: ${REASON_LABELS[reason]}${calls ? ` (${calls})` : ""}. ` +
      "Ни один из двух прогонов не оставил ни коммита, ни комментария, ни документа. Автоповтор остановлен. " +
      "Нужна новая вводная: уточнить задачу или разбить её на части по 1–2 часа."
    );
  }
  return (
    `Прогон остановлен защитой: ${REASON_LABELS[reason]}${calls ? ` (${calls})` : ""}. ` +
    "Нужна новая вводная: уточнить задачу или разбить её; автоповтора не будет."
  );
}

/** Notice seed for the stranded-recovery escalation, or null when the run was not guard-stopped. */
export function buildRunGuardStopNotice(
  run: RunGuardStopRunShape | null | undefined,
  stats?: RunGuardStopStats | null,
  opts?: { repeatedEmpty?: boolean },
): { body: string; title: string; tone: "danger"; nextAction: string } | null {
  const body = buildRunGuardStopComment(run, stats, opts);
  return body
    ? { body, title: RUN_GUARD_STOP_NOTICE_TITLE, tone: "danger", nextAction: RUN_GUARD_STOP_NOTICE_NEXT_ACTION }
    : null;
}
