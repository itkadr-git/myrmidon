// myrmidon(RUN-GUARD-HINT): the text of the run guard's messages to a running
// agent. The guard itself (run-guard.ts) only decides; an adapter that can put
// a message into the running dialog renders the decision with this function,
// so every adapter tells the agent the same thing in the same words.
//
// The function lived in the hermes gateway adapter. It moved here when the omp
// adapter got the same guard: hermes steers the message through the gateway
// (POST /v1/runs/{id}/steer), omp hands it to the session through its steer
// file (packages/adapters/omp-local/src/server/run-guard.ts).

/**
 * Every hint-before-stop reason an adapter can render.
 * `repeated_tool_call` / `model_call_limit` come from the RunGuard,
 * `repeated_tool_failure` from the hermes same-call tool failure guard
 * (OPE-12796, OPE-12878).
 */
export type RunGuardHintReason = "repeated_tool_call" | "model_call_limit" | "repeated_tool_failure";

export interface RunGuardHintInput {
  reason: RunGuardHintReason;
  tool?: string;
  repeatCount?: number;
  modelCalls?: number;
  /**
   * myrmidon(OPE-12799): set on the wrap-up hint only: the model calls left
   * before the run is stopped at the call limit.
   */
  remaining?: number;
  /** myrmidon(OPE-12878): the failing call's preview and error text, set by
   * the tool failure guard's hint. */
  callPreview?: string;
  errorText?: string | null;
}

export function buildRunGuardHintMessage(hint: RunGuardHintInput): string {
  // myrmidon(OPE-12799): the wrap-up message, sent while the run still has calls
  // left. The next run starts in a fresh session and sees only what is pushed and
  // what is written on the task, so the agent is told to put its work there.
  if (hint.reason === "model_call_limit" && typeof hint.remaining === "number" && hint.remaining > 0) {
    return (
      `Защита: до остановки прогона осталось ${hint.remaining} вызовов модели. ` +
      "Сохрани сделанное сейчас: закоммить и запушь изменения в ветку задачи, затем напиши комментарий в задаче — " +
      "что сделано, что осталось и с чего продолжить. Следующий прогон начнётся с чистой сессии и увидит только " +
      "запушенные коммиты и этот комментарий. Если задача закончена — заверши её как обычно."
    );
  }
  if (hint.reason === "repeated_tool_call") {
    const tool = hint.tool ?? "инструмент";
    const count = hint.repeatCount ?? 3;
    return `Защита: вызываешь ${tool} с теми же аргументами ${count}-й раз — смени подход: читай другое место или другим инструментом, переходи к правке по задаче`;
  }
  if (hint.reason === "repeated_tool_failure") {
    const tool = hint.tool ?? "инструмент";
    const count = hint.repeatCount ?? 3;
    const call = hint.callPreview ? ` (${hint.callPreview})` : "";
    const err = hint.errorText ? ` Ошибка: ${hint.errorText}.` : "";
    return `Защита: ${tool}${call} упал с той же ошибкой ${count}-й раз подряд.${err} Смени подход: исправь причину сбоя, используй другой инструмент или путь — повтор того же вызова остановит прогон`;
  }
  return "Защита: лимит вызовов модели, записей не было — переходи к правке по месту из задачи или опиши блокер в комментарии";
}
