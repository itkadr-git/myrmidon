import { evaluateTaskCardReadiness } from "@myrmidon/shared";
import { unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";

export const TASK_CARD_NOT_READY = "task_card_not_ready";

export const TASK_CARD_GATE_START_DATE = new Date("2026-11-07T00:00:00Z");
export const TASK_CARD_GATE_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * warning/enforce mode for the task-card-readiness gate, by the same rules as
 * getKnowledgeGateMode: an explicit env override wins; otherwise the gate runs
 * in warning mode for a 3-day grace period from the start date and switches to
 * enforce afterwards.
 */
export function getTaskCardGateMode(
  now: Date = new Date(),
  options?: { startDate?: Date; gracePeriodMs?: number },
): "warning" | "enforce" {
  if (process.env.MYRMIDON_TASK_CARD_GATE_MODE === "enforce") return "enforce";
  if (process.env.MYRMIDON_TASK_CARD_GATE_MODE === "warning") return "warning";
  const start =
    options?.startDate ??
    (process.env.MYRMIDON_TASK_CARD_GATE_START_DATE
      ? new Date(process.env.MYRMIDON_TASK_CARD_GATE_START_DATE)
      : TASK_CARD_GATE_START_DATE);
  const grace = options?.gracePeriodMs ?? TASK_CARD_GATE_GRACE_PERIOD_MS;
  return now.getTime() - start.getTime() < grace ? "warning" : "enforce";
}

/**
 * The card the gate evaluates. The gate itself only knows how to check;
 * deciding when to apply the check (issue create/update/status transitions)
 * is slice 3's concern and is deliberately out of scope here.
 */
export type TaskCardGateIssue = {
  title?: string | null;
  description?: string | null;
  descriptionTruncated?: boolean;
};

/**
 * Assert that a task card is ready to be handed to an engineer.
 *
 * - enforce mode: a not-ready card throws 422 with code
 *   `task_card_not_ready` and the checker's violation list;
 * - warning mode: the same problem is only logged, never thrown;
 * - a ready card passes silently in both modes.
 */
export function assertTaskCardReady(
  issue: TaskCardGateIssue,
  options?: { now?: Date; forceEnforce?: boolean },
): void {
  const result = evaluateTaskCardReadiness({
    title: issue.title ?? "",
    description: issue.description ?? null,
    descriptionTruncated: issue.descriptionTruncated,
  });
  if (result.ready) return;

  const mode = options?.forceEnforce ? "enforce" : getTaskCardGateMode(options?.now);
  if (mode === "warning") {
    logger.warn(
      { errorKind: "task_card_not_ready_warning", violations: result.violations },
      "Warning: task card is not ready for an engineer (missing sections or unresolved markers). Enforcing 422 after the grace period.",
    );
    return;
  }

  throw unprocessable(
    "Задача не готова к передаче инженеру: карточка не прошла проверку полноты (TASK_CARD_NOT_READY).",
    {
      code: TASK_CARD_NOT_READY,
      violations: result.violations,
    },
  );
}
