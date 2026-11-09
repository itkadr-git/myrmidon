import { evaluateTaskCardReadiness, type TaskCardReadinessViolation } from "@myrmidon/shared";
import { unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import {
  extractEditTargetPaths,
  verifyEditTargets,
  type EditTargetCredential,
  type FetchLike,
} from "./edit-target.js";

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

/** Everything the edit-target check needs from the caller's context. */
export type TaskCardEditTargetContext = {
  /** `owner/repo` of the repository the card edits; null means "unknown". */
  repository?: string | null;
  /** What the GitHub credential layer answered for this company/run. */
  credentials?: EditTargetCredential;
  /** Default branch, when the caller already knows it. */
  defaultBranch?: string | null;
  hostname?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

/**
 * TASK-CARD-READINESS-4 (OPE-12169): the readiness gate plus the live check
 * that every path named by «МЕСТО ПРАВКИ» exists on the default branch.
 *
 * The two checks differ in what a failure means:
 * - the card is incomplete → 422 `task_card_not_ready` (slice 2's contract);
 * - a named path is absent → 422 with `EDIT_TARGET_NOT_FOUND` among the
 *   violations, same code and same shape;
 * - the path could not be checked (no connection, network, auth, timeout) →
 *   a warning-severity violation, logged, and the transition is allowed. A
 *   GitHub outage must never freeze the board.
 *
 * Warnings alone never make the card not-ready; only error-severity
 * violations do. Paths the card marks as new files are not probed at all.
 */
export async function assertTaskCardReadyWithEditTargets(
  issue: TaskCardGateIssue,
  options?: {
    now?: Date;
    forceEnforce?: boolean;
    editTargets?: TaskCardEditTargetContext;
  },
): Promise<void> {
  const description = issue.description ?? null;
  const readiness = evaluateTaskCardReadiness({
    title: issue.title ?? "",
    description,
    descriptionTruncated: issue.descriptionTruncated,
  });

  const paths = extractEditTargetPaths(description);
  const editTarget = await verifyEditTargets({
    paths,
    repository: options?.editTargets?.repository ?? null,
    credentials: options?.editTargets?.credentials,
    defaultBranch: options?.editTargets?.defaultBranch ?? null,
    hostname: options?.editTargets?.hostname,
    fetch: options?.editTargets?.fetch,
    timeoutMs: options?.editTargets?.timeoutMs,
  });

  // Warnings are logged here and never accumulate into the blocking list.
  const warnings = editTarget.allViolations.filter((violation) => violation.severity === "warning");
  if (warnings.length > 0) {
    logger.warn(
      { errorKind: "task_card_edit_target_unverified", violations: warnings },
      "Warning: the place of edit of this card could not be fully verified against GitHub. The transition is allowed.",
    );
  }

  const violations: TaskCardReadinessViolation[] = [...readiness.violations, ...editTarget.violations];
  if (violations.length === 0) return;

  const mode = options?.forceEnforce ? "enforce" : getTaskCardGateMode(options?.now);
  if (mode === "warning") {
    logger.warn(
      { errorKind: "task_card_not_ready_warning", violations },
      "Warning: task card is not ready for an engineer (missing sections, unresolved markers, or a missing place of edit). Enforcing 422 after the grace period.",
    );
    return;
  }

  const editTargetMissing = editTarget.violations.length > 0;
  throw unprocessable(
    editTargetMissing
      ? "Задача не готова к передаче инженеру: место правки из карточки не найдено в репозитории (EDIT_TARGET_NOT_FOUND)."
      : "Задача не готова к передаче инженеру: карточка не прошла проверку полноты (TASK_CARD_NOT_READY).",
    {
      code: TASK_CARD_NOT_READY,
      violations,
    },
  );
}
