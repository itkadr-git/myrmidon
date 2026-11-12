// myrmidon(OPE-12802): what the retry of a run interrupted by maintenance is told.
// The retry starts a clean session and sees only pushed commits, the issue's
// comments and the continuation summary; without an instruction it redoes the
// work from zero (11.11 and 12.11: 16 runs of up to 199 calls restarted blind).
// Same carrier as the other continuations: contextSnapshot.livenessContinuationInstruction.

export const MAINTENANCE_RETRY_CONTINUATION_STATE = "maintenance_interrupt_retry";

export interface MaintenanceInterruptedRun {
  runId: string;
  windowId: string;
  /** When the interrupted run last did something useful; null when unknown. */
  lastUsefulActionAt?: Date | string | null;
}

function formatInstant(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Instruction for the retry: continue from what was saved, do not start over. */
export function buildMaintenanceRetryInstruction(run: MaintenanceInterruptedRun): string {
  const last = formatInstant(run.lastUsefulActionAt);
  return [
    `Предыдущий прогон ${run.runId} прерван перезапуском доски (окно ${run.windowId}), а не твоей ошибкой.`,
    "Всё, что он не успел закоммитить и запушить, потеряно.",
    last ? `Последнее полезное действие прерванного прогона: ${last}.` : null,
    "Не начинай заново: прочитай комментарии задачи и последние запушенные коммиты ветки, продолжи с последнего сохранённого места.",
    "Коммить и пушь после каждого законченного шага.",
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
}

/** The fields scheduleBoundedRetry carries into the retry's context. */
export function maintenanceRetryContinuation(run: MaintenanceInterruptedRun) {
  return {
    livenessContinuationInstruction: buildMaintenanceRetryInstruction(run),
    livenessContinuationState: MAINTENANCE_RETRY_CONTINUATION_STATE,
  };
}
