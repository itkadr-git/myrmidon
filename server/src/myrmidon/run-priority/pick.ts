// myrmidon(1.6.5 RUN-PRIORITY-PICK): the per-agent pass starts the agent's most
// important ready task, not merely the best of the runs already standing in the
// queue.
//
// The queue only ever compared standing runs (RUN-PRIORITY A): a run driven by
// an event (a comment, `issue_continuation_needed`, `execution_hold_cleared`)
// holds the agent busy on a low-importance task, and the agent's critical task
// — assigned, ready, without a run — never enters the comparison, so it never
// starts. The only place that already picks by *task* importance is the idle
// pickup (`idle-pickup.ts`, "highest priority first"), and it runs only for an
// agent without a live run: by the time the low event-run ends, the next event
// on it wakes the agent again and the pick is never reached.
//
// This module closes that gap at the per-agent queue pass. Before the pass
// starts the agent's best standing run, it asks the idle pickup for the agent's
// top ready task and compares it with the run about to start:
//
//   * the ready task is MORE important (higher issue-priority step, plus the
//     pheromone strength term the same weight carries) -> wake the agent for
//     that task and hold the standing run in the queue, with a wait reason that
//     says why (`higher_priority_ready`);
//   * anything else -> nothing changes; the pass starts its best run as before.
//
// Importance is compared by the *task's own* step (the issue-priority weight
// from `runPriorityWeight`'s issue term, plus the extra strength term), never by
// the composed run weight: a low run waiting past the starvation limit or a run
// that aged into a bonus must not outrank a more important task that has no run
// at all. That is the same rule the starvation escape now follows in the shared
// scoring (`runPriorityStepCeiling`).
//
// The pass never holds a run unless a wake was actually emitted: a suppressed
// wake (a paused agent, the idle-wake budget, a coalesced duplicate, the
// behaviour switched off) leaves the queue exactly as it was, so the fix can
// never starve an agent by holding its only standing run while its more
// important task stays unwoken. A task the operator just cancelled is the other
// exception: the mechanism that cancelled it must not put it straight back
// (`shouldSkipPickForOperatorCancellation`), so a repeat needs a *new* event on
// the task, not another sweep.

import {
  runPriorityWeight,
  type RunPrioritySettings,
} from "@paperclipai/shared";

/**
 * Why a run stays queued while a more important task of the same agent wakes
 * first. Written onto the run (`contextSnapshot.waitReason`) like the other
 * sweep reasons, so the run card says what happened.
 */
export const RUN_PRIORITY_PICK_WAIT_REASON = "higher_priority_ready";

/**
 * The strength term added to an issue's importance on top of its priority
 * weight: the pheromone strength of OPE-6614 (PR #1047) mixes into the run
 * weight through this same field, so the pick compares the composed importance
 * — priority *and* pheromone — instead of the bare priority. Absent (the field
 * is optional everywhere) it contributes 0 and the pick is priority-only.
 */
export function runPriorityPickExtraWeight(extraWeight: number | null | undefined): number {
  return typeof extraWeight === "number" && Number.isFinite(extraWeight) ? extraWeight : 0;
}

/**
 * The importance of one task: its issue-priority step from the live settings
 * plus the extra strength term. `null`/unknown priorities read as the `none`
 * step, exactly like `runPriorityWeight` reads them.
 */
export function runPriorityPickImportance(
  issuePriority: string | null | undefined,
  settings: RunPrioritySettings,
  extraWeight?: number | null,
): number {
  const key = issuePriority?.trim().toLowerCase() || "none";
  const step =
    settings.issuePriorityWeights[key] ??
    settings.issuePriorityWeights["none"] ??
    0;
  return step + runPriorityPickExtraWeight(extraWeight);
}

/** One standing queued run of the agent, as the per-agent pass sees it. */
export interface RunPriorityPickCandidate {
  runId: string;
  /** The task the run carries (`contextSnapshot.issueId`); null for a task-less run. */
  issueId: string | null;
  issuePriority: string | null | undefined;
  /** Pheromone/LANE-B strength of the run's task, when the weight carries one. */
  extraWeight?: number | null;
}

/** The agent's top ready task without a live run — what the idle pickup would wake. */
export interface RunPriorityPickReadyTask {
  issueId: string;
  issuePriority: string | null | undefined;
  extraWeight?: number | null;
}

export type RunPriorityPickReason =
  | "picked"
  | "disabled"
  | "no_candidates"
  | "no_ready_task"
  | "same_task"
  | "not_more_important"
  | "wake_suppressed"
  | "operator_cancelled";

export interface RunPriorityPickDecision {
  /** The task to start first; null means the pass keeps its own order. */
  pickIssueId: string | null;
  /** The standing runs that stay queued behind it (all the less important ones). */
  heldRunIds: string[];
  /** The standing run the pass would have started without the pick. */
  bestRunId: string | null;
  /** Importance of the ready task and of the best standing run. */
  readyImportance: number;
  bestImportance: number;
  reason: RunPriorityPickReason;
}

/**
 * The decision itself: pure, no clock, no database. `pickIssueId` is set only
 * when the agent has a standing run AND a ready task strictly more important
 * than the best of them; `heldRunIds` are the standing runs of a lower
 * importance (equal importance is NOT held: the run already standing keeps its
 * place, there is nothing to reorder between two tasks of one step. Because the
 * pick needs strict importance, every standing run sits below the ready task and
 * the equal case is a guard of the rule rather than a case the sweep can enter).
 */
export function decideRunPriorityPick(input: {
  settings: RunPrioritySettings;
  candidates: readonly RunPriorityPickCandidate[];
  readyTask: RunPriorityPickReadyTask | null;
}): RunPriorityPickDecision {
  const { settings, candidates, readyTask } = input;
  const empty = (reason: RunPriorityPickReason): RunPriorityPickDecision => ({
    pickIssueId: null,
    heldRunIds: [],
    bestRunId: null,
    readyImportance: 0,
    bestImportance: 0,
    reason,
  });
  if (!settings.enabled) return empty("disabled");
  if (candidates.length === 0) return empty("no_candidates");
  if (!readyTask) return empty("no_ready_task");

  // A run of the ready task itself is not a competitor: that task already has
  // its run standing (the caller's ready-task read skips it, this is the guard
  // for a caller that hands both in anyway).
  const rivals = candidates.filter(
    (candidate) => !candidate.issueId || candidate.issueId !== readyTask.issueId,
  );
  if (rivals.length === 0) return empty("same_task");

  let best: RunPriorityPickCandidate | null = null;
  let bestImportance = -Infinity;
  for (const candidate of rivals) {
    const importance = runPriorityPickImportance(
      candidate.issuePriority,
      settings,
      candidate.extraWeight,
    );
    if (importance > bestImportance) {
      best = candidate;
      bestImportance = importance;
    }
  }
  const readyImportance = runPriorityPickImportance(
    readyTask.issuePriority,
    settings,
    readyTask.extraWeight,
  );
  const base = {
    heldRunIds: [],
    bestRunId: best?.runId ?? null,
    readyImportance,
    bestImportance: Number.isFinite(bestImportance) ? bestImportance : 0,
  };
  if (readyImportance <= bestImportance) {
    return { ...base, pickIssueId: null, reason: "not_more_important" };
  }
  return {
    ...base,
    pickIssueId: readyTask.issueId,
    heldRunIds: rivals
      .filter(
        (candidate) =>
          runPriorityPickImportance(candidate.issuePriority, settings, candidate.extraWeight) <
          readyImportance,
      )
      .map((candidate) => candidate.runId),
    reason: "picked",
  };
}

/** What one operator cancellation of an issue's run leaves behind. */
export interface OperatorCancellationMark {
  /** The cancelled run's issue. */
  issueId: string;
  /** When the cancellation happened (epoch ms). */
  cancelledAtMs: number;
  /**
   * When a *new* event on the issue arrived after the cancellation (a wake
   * request created later — a comment, a continuation, a manual wake), or null
   * when nothing came. A newer event is new information: the task is fair game
   * again.
   */
  newEventAtMs: number | null;
}

/**
 * True when the pick must leave a task alone: an operator cancelled its run and
 * nothing happened on the task since.
 *
 * Requirement 3 of the ticket: a cancellation must not come straight back
 * through the mechanism that was just stopped — otherwise Stop is a no-op that
 * re-wakes the very run the operator killed. The task returns as soon as there
 * is a *new* event on it (a comment, a continuation, a manual wake) or as soon
 * as the agent has no more important work — the second half belongs to the
 * caller, which only asks for a pick while a more important task exists.
 */
export function shouldSkipPickForOperatorCancellation(
  mark: OperatorCancellationMark | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!mark) return false;
  if (!Number.isFinite(mark.cancelledAtMs)) return false;
  if (mark.newEventAtMs === null) return true;
  // A newer event counts only if it really is newer; a wake request recorded
  // with a coarser timestamp (or from the same second) is not new information.
  return mark.newEventAtMs <= mark.cancelledAtMs;
}

export interface RunPriorityPickOutcome {
  picked: boolean;
  reason: RunPriorityPickReason;
  issueId: string | null;
  heldRunIds: string[];
  readyImportance: number;
  bestImportance: number;
}

/**
 * The per-agent pass hook. Everything with a side effect is injected, so the
 * decision above stays pure and the wiring stays in the heartbeat service:
 *
 *  * `findReadyTask` — the agent's top ready task without a live run (the idle
 *    pickup's own read, `findTopReadyIssueForAgent`);
 *  * `wake` — wake the agent for it (the idle pickup, `idlePickupForAgent`);
 *    the resolved boolean says whether a wake was actually emitted;
 *  * `holdRuns` — record why the standing runs stay queued;
 *  * `operatorCancellation` — the cancellation mark of the ready task, if any.
 *
 * Returns whether it picked. `picked === false` never means "do nothing instead
 * of the normal pass": the caller starts its best standing run exactly as it
 * would have without this module. That is the safety net — the pick can only
 * ever *reorder* a start, never remove one.
 */
export async function runPriorityPickForAgent(deps: {
  settings: RunPrioritySettings;
  candidates: readonly RunPriorityPickCandidate[];
  findReadyTask: () => Promise<RunPriorityPickReadyTask | null>;
  wake: (task: RunPriorityPickReadyTask) => Promise<boolean>;
  holdRuns: (
    runIds: ReadonlyArray<string>,
    reason: typeof RUN_PRIORITY_PICK_WAIT_REASON,
    context: { pickedIssueId: string; readyImportance: number; bestImportance: number },
  ) => Promise<void>;
  operatorCancellation?: (issueId: string) => Promise<OperatorCancellationMark | null>;
  nowMs?: number;
  log?: (event: {
    agentId?: string;
    issueId: string | null;
    reason: RunPriorityPickReason;
    heldRunIds: string[];
    readyImportance: number;
    bestImportance: number;
  }) => void;
}): Promise<RunPriorityPickOutcome> {
  const nowMs = deps.nowMs ?? Date.now();
  const done = (reason: RunPriorityPickReason, decision?: RunPriorityPickDecision) => {
    const outcome: RunPriorityPickOutcome = {
      picked: reason === "picked",
      reason,
      issueId: reason === "picked" ? decision?.pickIssueId ?? null : null,
      heldRunIds: reason === "picked" ? decision?.heldRunIds ?? [] : [],
      readyImportance: decision?.readyImportance ?? 0,
      bestImportance: decision?.bestImportance ?? 0,
    };
    deps.log?.({
      issueId: outcome.issueId,
      reason,
      heldRunIds: outcome.heldRunIds,
      readyImportance: outcome.readyImportance,
      bestImportance: outcome.bestImportance,
    });
    return outcome;
  };

  if (!deps.settings.enabled) return done("disabled");
  // No standing runs of the agent: the pass has nothing to reorder, and the
  // ready-task read is a query we do not spend (the idle pickup sweeps alone).
  if (deps.candidates.length === 0) return done("no_candidates");
  const readyTask = await deps.findReadyTask();
  const decision = decideRunPriorityPick({
    settings: deps.settings,
    candidates: deps.candidates,
    readyTask,
  });
  if (decision.reason !== "picked" || !decision.pickIssueId) return done(decision.reason, decision);

  // Requirement 3: an operator's Stop is durable intent until the task gets new
  // information. Skipping here means the pass starts its standing run as usual
  // — the cancelled task is not pushed back into the queue by the sweep.
  if (deps.operatorCancellation) {
    try {
      const mark = await deps.operatorCancellation(decision.pickIssueId);
      if (shouldSkipPickForOperatorCancellation(mark, nowMs)) {
        return done("operator_cancelled", decision);
      }
    } catch {
      // A failed read must not stop the sweep; the pick proceeds, and the wake
      // path itself still applies every admission gate.
    }
  }

  const woken = await deps.wake({
    issueId: decision.pickIssueId,
    issuePriority: readyTask?.issuePriority ?? null,
    extraWeight: readyTask?.extraWeight ?? null,
  });
  if (!woken) {
    // No wake was emitted (budget, a paused agent, coalescing, the behaviour
    // switched off): the standing run keeps its place, nothing is held.
    return done("wake_suppressed", decision);
  }
  await deps.holdRuns(decision.heldRunIds, RUN_PRIORITY_PICK_WAIT_REASON, {
    pickedIssueId: decision.pickIssueId,
    readyImportance: decision.readyImportance,
    bestImportance: decision.bestImportance,
  });
  return done("picked", decision);
}

/**
 * The pick's weight view of a standing run and of a ready task, for the
 * heartbeat wiring: the pass already decorates its queued runs for
 * `runPriorityWeight`, and the ready task needs the very same shape to be
 * compared. Kept here so the two sides cannot drift apart.
 */
export function runPriorityPickWeights(input: {
  settings: RunPrioritySettings;
  agentRole: string | null;
  candidate?: {
    hasIssue: boolean;
    issuePriority: string | null | undefined;
    releaseMatched: boolean;
    createdAtMs: number;
  } | null;
  readyTask?: { issuePriority: string | null | undefined; releaseMatched: boolean } | null;
  nowMs?: number;
}): { candidateWeight: number | null; readyWeight: number | null } {
  const nowMs = input.nowMs ?? Date.now();
  const base = {
    role: input.agentRole,
    releaseMatched: false,
  };
  return {
    candidateWeight: input.candidate
      ? runPriorityWeight(
          {
            ...base,
            hasIssue: input.candidate.hasIssue,
            issuePriority: input.candidate.issuePriority,
            releaseMatched: input.candidate.releaseMatched,
            createdAtMs: input.candidate.createdAtMs,
          },
          input.settings,
          nowMs,
        )
      : null,
    readyWeight: input.readyTask
      ? runPriorityWeight(
          {
            ...base,
            hasIssue: true,
            issuePriority: input.readyTask.issuePriority,
            releaseMatched: input.readyTask.releaseMatched,
            createdAtMs: nowMs,
          },
          input.settings,
          nowMs,
        )
      : null,
  };
}