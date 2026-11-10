// server/src/myrmidon/goal-judge/controller.ts
//
// myrmidon(1.7-GOAL-JUDGE): the review-cycle round controller for the goal
// judge. Bridges `evaluateGoalJudge` (wiring.ts, per-call model rounds) into
// the review lifecycle: pass / return-to-executor / escalate decisions,
// round budgeting (<= MAX_ROUNDS per task), and the round ledger the host
// loop persists between sweeps.
//
// Rule: «заявлено, но не проверено = не сделано» (claimed, but not verified =
// not done). The judge is advisory unless the instance switch is on; when the
// switch is off the controller is a strict noop and must never block a review
// transition.
//
// OpenHands SDK (jigsaw-labs/Devin, MIT) contributed the *idea* of an
// LLM-as-judge loop with bounded rounds; the code here is original.

import { and, eq, sql } from "drizzle-orm";
import { issues, type Db } from "@myrmidon/db";
import type { IssueExecutionPolicy, IssueExecutionStagePrincipal } from "@myrmidon/shared";
import { MAX_ROUNDS, type GoalJudgeInput, type GoalJudgeVerdict } from "./domain.js";
import {
  evaluateGoalJudge,
  type GoalJudgeControllerDeps,
  type GoalJudgeEvaluationResult,
} from "./wiring.js";
import { resolveReviewEscalationParticipant } from "../../services/issue-execution-policy.js";

/** A review task the controller can judge. */
export interface GoalJudgeReviewTaskFacts {
  issueId: string;
  companyId: string;
  /** Current status of the task being judged. */
  status: string;
  /** Acceptance criteria (list, or the free-form body). */
  criteria: string[] | string;
  /** Unified diff of the delivered change, when resolvable. */
  diff?: string | null;
  /** Test/CI output captured for the head, when resolvable. */
  testOutput?: string | null;
  /** The executor's claims (PR body / latest delivery comment), if any. */
  claims?: string[] | string | null;
  /** Head SHA of the delivered change; re-judge only when it changes. */
  headSha?: string | null;
  /** Per-task round state, persisted by the host loop between passes. */
  roundState?: GoalJudgeRoundState | null;
  /** Per-task budget cap (issue's maxReviewRounds; default MAX_ROUNDS). */
  maxReviewRounds?: number | null;
  /** Return assignee (executor) when returning task on missing criteria. */
  returnAssigneeAgentId?: string | null;
  returnAssigneeUserId?: string | null;
  /** Execution policy on the issue, if configured. */
  executionPolicy?: IssueExecutionPolicy | null;
  /** Default escalation agent chain if available. */
  defaultEscalationAgentIds?: string[] | null;
}

/** Persisted per-task round state, stored by the host loop. */
export interface GoalJudgeRoundState {
  /** Judge rounds consumed for this task so far. */
  rounds: number;
  /** Epoch ms of the last judge pass; guards duplicate passes. */
  lastJudgedAtMs: number | null;
  /** Head SHA the last verdict pinned; re-judge only on head change. */
  lastHeadSha: string | null;
  /** The last verdict, reused verbatim in the escalation report. */
  lastVerdict: GoalJudgeVerdict | null;
}

/** Why the controller skipped judging for this task. */
export type GoalJudgeNoopReason =
  | "goal_judge_disabled"
  | "not_a_review_task"
  | "missing_criteria"
  | "round_budget_exhausted"
  | "head_unchanged"
  | "judge_unavailable";

/** All round-controller outcomes. */
export type GoalJudgeDecision =
  | {
      kind: "pass";
      verdict: GoalJudgeVerdict;
      roundsUsed: number;
      patch?: { status?: string };
      commentBody?: string | null;
    }
  | {
      kind: "return_to_executor";
      verdict: GoalJudgeVerdict;
      roundsUsed: number;
      patch: {
        status: "in_progress";
        assigneeAgentId?: string | null;
        assigneeUserId?: string | null;
      };
      commentBody: string;
    }
  | {
      kind: "escalate_to_reviewer";
      verdict: GoalJudgeVerdict;
      /** True when the verdict came from the ledger, not a fresh call. */
      fromLedger: boolean;
      roundsUsed: number;
      patch?: {
        status: "in_review";
        assigneeAgentId?: string | null;
        assigneeUserId?: string | null;
      };
      commentBody: string;
      escalationParticipant?: IssueExecutionStagePrincipal | null;
    }
  | { kind: "noop"; reason: GoalJudgeNoopReason };

/** Extra deps the controller needs beyond the wiring controller deps. */
export interface GoalJudgeRoundControllerDeps extends GoalJudgeControllerDeps {
  /** Optional ledger sink; defaults to an in-process map (single sweep loop). */
  ledger?: GoalJudgeRoundLedger;
}

/**
 * Round ledger port: the host loop may persist these entries; the default
 * implementation keeps them in memory for the life of the sweep.
 */
export interface GoalJudgeRoundLedger {
  load(companyId: string, issueId: string): Promise<GoalJudgeRoundState | null>;
  save(companyId: string, issueId: string, state: GoalJudgeRoundState): Promise<void>;
  clear(companyId: string, issueId: string): Promise<void>;
}

/** In-memory ledger; adequate for a single sweep loop process. */
export function createInMemoryGoalJudgeLedger(): GoalJudgeRoundLedger {
  const map = new Map<string, GoalJudgeRoundState>();
  const key = (companyId: string, issueId: string) => `${companyId}:${issueId}`;
  return {
    async load(companyId, issueId) {
      return map.get(key(companyId, issueId)) ?? null;
    },
    async save(companyId, issueId, state) {
      map.set(key(companyId, issueId), state);
    },
    async clear(companyId, issueId) {
      map.delete(key(companyId, issueId));
    },
  };
}

/**
 * PostgreSQL-backed round ledger (myrmidon 1.7-GOAL-JUDGE, OPE-12149).
 *
 * Persists each task's round state in `issues.execution_state -> 'goalJudgeRound'`
 * (jsonb_set): no schema change, survives sweep restarts, per-company controller
 * recreation and multi-worker deployments. `save`/`clear` rewrite only the
 * `goalJudgeRound` key, so concurrent executionState writers (review requests,
 * escalation bookkeeping) are not clobbered.
 */
export function createPgGoalJudgeLedger(db: Db): GoalJudgeRoundLedger {
  return {
    async load(companyId, issueId) {
      const rows = await db
        .select({ executionState: issues.executionState })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
        .limit(1);
      const executionState = rows[0]?.executionState as Record<string, unknown> | null | undefined;
      const roundState = executionState?.goalJudgeRound as GoalJudgeRoundState | null | undefined;
      if (!roundState || typeof roundState?.rounds !== "number") return null;
      return roundState;
    },
    async save(companyId, issueId, state) {
      await db
        .update(issues)
        .set({
          executionState: sql`jsonb_set(coalesce(${issues.executionState}, '{}'::jsonb), '{goalJudgeRound}', ${JSON.stringify(state)}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    },
    async clear(companyId, issueId) {
      await db
        .update(issues)
        .set({
          executionState: sql`coalesce(${issues.executionState}, '{}'::jsonb) - 'goalJudgeRound'`,
          updatedAt: new Date(),
        })
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    },
  };
}

/** Resolves the effective per-task round cap (issue cap first, then default). */
export function resolveMaxRounds(input: {
  maxReviewRounds?: number | null;
  settingsMaxRounds?: number | null;
  executionPolicy?: IssueExecutionPolicy | null;
}): number {
  const policyCap =
    input.executionPolicy?.reviewEscalationPolicy?.maxReviewRounds ??
    input.executionPolicy?.maxReviewRounds ??
    input.maxReviewRounds;
  const candidate =
    typeof policyCap === "number" && policyCap > 0
      ? policyCap
      : typeof input.settingsMaxRounds === "number" && input.settingsMaxRounds > 0
        ? input.settingsMaxRounds
        : MAX_ROUNDS;
  return Math.min(candidate, MAX_ROUNDS);
}

/** Formats the return-to-executor comment (as REQUEST CHANGES). */
export function formatGoalJudgeReturnComment(input: {
  verdict: GoalJudgeVerdict;
  round: number;
  maxRounds: number;
}): string {
  const missingList = input.verdict.missing.map((m) => `- ${m}`).join("\n");
  const scorePercent = Math.round(input.verdict.score * 100);
  return [
    `[GOAL-JUDGE] Complete: false (${scorePercent}%, round ${input.round}/${input.maxRounds})`,
    "«Заявлено, но не проверено = не сделано» — критерии не подтверждены доказательствами в коде или тестах.",
    "",
    "### Невыполненные или неподтверждённые критерии (missing):",
    missingList || "- (Не указаны конкретные критерии)",
    ...(input.verdict.summary ? ["", `Резюме судьи: ${input.verdict.summary}`] : []),
    "",
    "Задача возвращена исполнителю (status: in_progress). Устраните замечания и переведите задачу в ревью повторно.",
  ].join("\n");
}

/** Formats the escalation report comment for the reviewer. */
export function formatGoalJudgeEscalationComment(input: {
  verdict: GoalJudgeVerdict;
  round: number;
  maxRounds: number;
  escalationParticipant?: IssueExecutionStagePrincipal | null;
}): string {
  const missingList = input.verdict.missing.map((m) => `- ${m}`).join("\n");
  const scorePercent = Math.round(input.verdict.score * 100);
  return [
    `[GOAL-JUDGE ESCALATION] Лимит раундов судьи исчерпан (${input.round}/${input.maxRounds}).`,
    `Отчёт судьи: score=${input.verdict.score.toFixed(2)} (${scorePercent}%), complete=false.`,
    "",
    "### Неподтверждённые критерии (missing):",
    missingList || "- (Не указаны)",
    ...(input.verdict.summary ? ["", `Резюме судьи: ${input.verdict.summary}`] : []),
    "",
    "Эскалация ревьюеру для принятия окончательного решения (задача остаётся в ревью).",
  ].join("\n");
}

/** Builds the goal judge round controller. */
export function createGoalJudgeRoundController(
  deps: GoalJudgeRoundControllerDeps,
): { judge(input: GoalJudgeReviewTaskFacts): Promise<GoalJudgeDecision> } {
  const ledger = deps.ledger ?? createInMemoryGoalJudgeLedger();

  return {
    async judge(input: GoalJudgeReviewTaskFacts): Promise<GoalJudgeDecision> {
      const settings = await deps.settings.read();
      if (!settings.enabled) {
        return { kind: "noop", reason: "goal_judge_disabled" };
      }
      if (input.status !== "in_review") {
        return { kind: "noop", reason: "not_a_review_task" };
      }
      const criteria =
        Array.isArray(input.criteria) && input.criteria.length > 0
          ? input.criteria
          : typeof input.criteria === "string" && input.criteria.trim().length > 0
            ? input.criteria
            : null;
      if (!criteria) {
        return { kind: "noop", reason: "missing_criteria" };
      }

      const state =
        input.roundState ??
        (await ledger.load(input.companyId, input.issueId)) ??
        ({
          rounds: 0,
          lastJudgedAtMs: null,
          lastHeadSha: null,
          lastVerdict: null,
        } satisfies GoalJudgeRoundState);
      const maxRounds = resolveMaxRounds({
        maxReviewRounds: input.maxReviewRounds,
        settingsMaxRounds: settings.maxRounds ?? null,
        executionPolicy: input.executionPolicy,
      });

      // The head the ledger pinned: re-judge only when it changed.
      if (state.lastHeadSha && input.headSha && state.lastHeadSha === input.headSha) {
        if (state.rounds >= maxRounds && state.lastVerdict && !state.lastVerdict.complete) {
          return escalate(input, state, maxRounds, true);
        }
        if (state.lastVerdict?.complete) {
          return {
            kind: "pass",
            verdict: state.lastVerdict,
            roundsUsed: state.rounds,
            patch: { status: "in_review" },
          };
        }
        return { kind: "noop", reason: "head_unchanged" };
      }

      // Budget check BEFORE spending a model round (enforce <= maxRounds).
      if (state.rounds >= maxRounds) {
        if (state.lastVerdict && !state.lastVerdict.complete) {
          return escalate(input, state, maxRounds, false);
        }
        return { kind: "noop", reason: "round_budget_exhausted" };
      }

      const judgeInput: GoalJudgeInput = {
        criteria,
        diff: input.diff ?? null,
        testOutput: input.testOutput ?? null,
        claims: input.claims ?? null,
      };
      let evaluation: GoalJudgeEvaluationResult;
      try {
        evaluation = await evaluateGoalJudge(
          {
            ...deps,
            settings: {
              read: async () => {
                const s = await deps.settings.read();
                return { ...s, maxRounds: 1 };
              },
            },
          },
          judgeInput,
        );
      } catch {
        // Unconfigured provider etc.: leave the loop untouched this pass.
        return { kind: "noop", reason: "judge_unavailable" };
      }
      if (!evaluation.executed || !evaluation.verdict) {
        return {
          kind: "noop",
          reason: evaluation.skippedReason === "goal_judge_disabled" ? "goal_judge_disabled" : "judge_unavailable",
        };
      }

      const verdict = evaluation.verdict;
      const roundsUsed = state.rounds + 1;
      const nextState: GoalJudgeRoundState = {
        rounds: roundsUsed,
        lastJudgedAtMs: Date.now(),
        lastHeadSha: input.headSha ?? null,
        lastVerdict: verdict,
      };

      if (verdict.complete && verdict.missing.length === 0) {
        await ledger.save(input.companyId, input.issueId, nextState);
        return {
          kind: "pass",
          verdict,
          roundsUsed,
          patch: { status: "in_review" },
          commentBody: null,
        };
      }

      if (roundsUsed >= maxRounds) {
        await ledger.save(input.companyId, input.issueId, nextState);
        return escalateFromVerdict(input, verdict, roundsUsed, maxRounds, false);
      }

      await ledger.save(input.companyId, input.issueId, nextState);
      return {
        kind: "return_to_executor",
        verdict,
        roundsUsed,
        patch: {
          status: "in_progress",
          ...(input.returnAssigneeAgentId !== undefined
            ? { assigneeAgentId: input.returnAssigneeAgentId }
            : {}),
          ...(input.returnAssigneeUserId !== undefined
            ? { assigneeUserId: input.returnAssigneeUserId }
            : {}),
        },
        commentBody: formatGoalJudgeReturnComment({
          verdict,
          round: roundsUsed,
          maxRounds,
        }),
      };
    },
  };
}

function escalate(
  input: GoalJudgeReviewTaskFacts,
  state: GoalJudgeRoundState,
  maxRounds: number,
  fromLedger: boolean,
): GoalJudgeDecision {
  return escalateFromVerdict(
    input,
    state.lastVerdict as GoalJudgeVerdict,
    state.rounds,
    maxRounds,
    fromLedger,
  );
}

function escalateFromVerdict(
  input: GoalJudgeReviewTaskFacts,
  verdict: GoalJudgeVerdict,
  roundsUsed: number,
  maxRounds: number,
  fromLedger: boolean,
): GoalJudgeDecision {
  const policyReviewEscalation = input.executionPolicy?.reviewEscalationPolicy as any;
  const defaultEscalationAgentIds =
    input.defaultEscalationAgentIds ??
    (Array.isArray(policyReviewEscalation?.escalationAgentIds)
      ? policyReviewEscalation.escalationAgentIds
      : null);
  let escalationParticipant: IssueExecutionStagePrincipal | null = null;
  if (input.executionPolicy) {
    try {
      escalationParticipant = resolveReviewEscalationParticipant(
        {
          id: input.issueId,
          companyId: input.companyId,
          status: input.status,
          defaultEscalationAgentIds,
        } as unknown as Parameters<typeof resolveReviewEscalationParticipant>[0],
        input.executionPolicy,
      );
    } catch {
      escalationParticipant = null;
    }
  }
  if (!escalationParticipant && defaultEscalationAgentIds && defaultEscalationAgentIds.length > 0) {
    escalationParticipant = { type: "agent", agentId: defaultEscalationAgentIds[0], userId: null };
  }

  return {
    kind: "escalate_to_reviewer",
    verdict,
    fromLedger,
    roundsUsed,
    patch: {
      status: "in_review",
      ...(escalationParticipant?.agentId ? { assigneeAgentId: escalationParticipant.agentId } : {}),
      ...(escalationParticipant?.userId ? { assigneeUserId: escalationParticipant.userId } : {}),
    },
    commentBody: formatGoalJudgeEscalationComment({
      verdict,
      round: roundsUsed,
      maxRounds,
      escalationParticipant,
    }),
    escalationParticipant,
  };
}
