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
// This module holds the pure parts: recognising a guard-stopped run and the
// comment text. The wiring is in services/heartbeat.ts (stop handling and the
// retry scheduler) and services/recovery/service.ts (the stranded sweep).

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
): string | null {
  const reason = readRunGuardStopReason(run);
  if (!reason || !run) return null;
  const calls = describeCalls(run, stats);
  return (
    `Прогон остановлен защитой: ${REASON_LABELS[reason]}${calls ? ` (${calls})` : ""}. ` +
    "Нужна новая вводная: уточнить задачу или разбить её; автоповтора не будет."
  );
}

/** Notice seed for the stranded-recovery escalation, or null when the run was not guard-stopped. */
export function buildRunGuardStopNotice(
  run: RunGuardStopRunShape | null | undefined,
  stats?: RunGuardStopStats | null,
): { body: string; title: string; tone: "danger"; nextAction: string } | null {
  const body = buildRunGuardStopComment(run, stats);
  return body
    ? { body, title: RUN_GUARD_STOP_NOTICE_TITLE, tone: "danger", nextAction: RUN_GUARD_STOP_NOTICE_NEXT_ACTION }
    : null;
}
