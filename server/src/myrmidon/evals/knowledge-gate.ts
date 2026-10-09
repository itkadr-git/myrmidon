// server/src/myrmidon/evals/knowledge-gate.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-9): the evals gate of knowledge.
//
// Architecture §4.2 step 7: publishing a rule/skill (and a `deliver` page)
// opens a judge run; a drop beyond the threshold, *confirmed by a repeat*,
// rolls the item back automatically and leaves a card for the owner
// postfactum. The knowledge journal carries `eval_run_id` and `delta` for
// every judged publication, so the quality page can answer "which judge run
// gated this item, and by how much did it move the caste".
//
// This file owns the wiring only; the scoring and the threshold live in
// `./domain.js` and `./service.js`, the knowledge lifecycle in the knowledge
// module. Both sides are reached through narrow ports so the gate can be
// exercised end to end on a synthetic rule without a gateway or a database.
//
// Budget: at most two judge runs per publication (first + confirmation),
// which is what makes "a deliberately bad rule rolls back within ≤ 2 judge
// runs" true by construction.

import { type EvalSubjectKind, type EvalTaskScore } from "./domain.js";
import type { EvalRunRecord, EvalsService, EvalTaskRow, RunOutcome } from "./service.js";

/** The lifecycle events that open the gate (architecture §3.5 / §4.2 step 7). */
export const KNOWLEDGE_GATE_TRIGGERS = ["rule.approved", "skill.promoted", "page.published"] as const;
export type KnowledgeGateTrigger = (typeof KNOWLEDGE_GATE_TRIGGERS)[number];

export function isKnowledgeGateTrigger(value: unknown): value is KnowledgeGateTrigger {
  return typeof value === "string" && (KNOWLEDGE_GATE_TRIGGERS as readonly string[]).includes(value);
}

/**
 * Which kind of knowledge item a trigger gates. Kept next to the trigger list
 * so the two can never drift: the hook passes the event, the gate derives the
 * `subject_kind` that lands on the run row.
 */
export function subjectKindForTrigger(trigger: KnowledgeGateTrigger): EvalSubjectKind {
  switch (trigger) {
    case "rule.approved":
      return "rule";
    case "skill.promoted":
      return "skill";
    case "page.published":
      return "page";
  }
}

/** A criterion named like this scored 0 means the item hallucinated. */
export const HALLUCINATION_CRITERION_PATTERN = /hallucinat/i;

/**
 * The gate verdict, reduced to the two things knowledge cares about: keep the
 * delivery, or roll it back. The judge's richer vocabulary (`promote`,
 * `confirm`, `regress`, `error`) stays in evals.
 */
export const KNOWLEDGE_GATE_VERDICTS = ["keep", "rollback"] as const;
export type KnowledgeGateVerdict = (typeof KNOWLEDGE_GATE_VERDICTS)[number];

export interface KnowledgeGateInput {
  trigger: KnowledgeGateTrigger;
  companyId: string;
  /** The nest holding the item; today `nestId === companyId`. */
  nestId: string;
  /** The item id or slug knowledge.rollback takes. */
  itemRef: string;
  /** The item slug, recorded as `subject_ref` on the runs. */
  slug: string;
  /** The reference-task role whose judge gates this item (the caste). */
  role: string;
  /**
   * The delivered text of the item — what the judge reads as the caste's
   * answer. One text for every reference task of the role.
   */
  content: string;
  /** The last good delivered revision the rollback returns to. */
  rollbackToRevisionId: string;
  /** The revision the gate is judging (provenance in the journal line). */
  revisionId?: string | null;
  /** The completed baseline run to compare against; absent = no judgement. */
  baselineRunId?: string | null;
  /** Points allowed to drop before the gate asks for a repeat. */
  thresholdDrop?: number | null;
  /** Board actor recorded on the rollback and the journal line. */
  actor: KnowledgeGateActor;
  /**
   * Set when a human/judge already saw a hallucination in the delivery: the
   * gate rolls back immediately, without spending the repeat run
   * (architecture §4.2 step 7: "галлюцинация цены — откат сразу").
   */
  hallucination?: { taskSlug: string; note?: string | null } | null;
}

/** The actor shape the knowledge module records on lifecycle events. */
export interface KnowledgeGateActor {
  actorType: string;
  actorId: string;
}

export interface KnowledgeGateRollbackRequest {
  nestId: string;
  itemRef: string;
  /** The revision to return to — the pointer back to the last good delivery. */
  targetRevisionId: string;
  changeSummary: string;
  actor: KnowledgeGateActor;
  evalRunId: string;
  delta: number | null;
}

export interface KnowledgeGateJournalEntry {
  nestId: string;
  itemRef: string;
  subjectKind: EvalSubjectKind;
  subjectRef: string;
  evalRunId: string;
  delta: number | null;
  verdict: KnowledgeGateVerdict;
  trigger: KnowledgeGateTrigger;
  reason: string | null;
  /** True when the owner must be told after the fact ("откачено, причина"). */
  ownerNotice: boolean;
}

/** The owner card posted postfactum; never blocks the rollback. */
export interface KnowledgeGateOwnerNotice {
  nestId: string;
  itemRef: string;
  slug: string;
  subjectKind: EvalSubjectKind;
  verdict: KnowledgeGateVerdict;
  reason: string;
  evalRunId: string;
  delta: number | null;
}

/**
 * What the gate needs from knowledge: the pointer back, one journal line per
 * judged publication, and the owner card. The knowledge module implements
 * these (`createKnowledgeGateSink`); tests pass a recorder.
 */
export interface KnowledgeGateSink {
  rollback(input: KnowledgeGateRollbackRequest): Promise<void>;
  recordJournal(input: KnowledgeGateJournalEntry): Promise<void>;
  notifyOwner(input: KnowledgeGateOwnerNotice): Promise<void>;
}

export interface KnowledgeGateOutcome {
  verdict: KnowledgeGateVerdict;
  reason: string;
  /** The judge run the verdict was taken from (the repeat when one ran). */
  runId: string;
  firstRunId: string;
  confirmRunId: string | null;
  /** Points lost against the baseline; null when there was no comparison. */
  delta: number | null;
  /** How many judge runs the gate spent (1 or 2). */
  judgeRuns: number;
  rolledBack: boolean;
  ownerNotified: boolean;
}
export class KnowledgeGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeGateError";
  }
}

export interface KnowledgeGateDeps {
  /** The evals service: judge runs only, no routing. */
  evals: Pick<EvalsService, "runEval" | "runConfirmation" | "loadTasks" | "getRun">;
  /** The knowledge side: pointer back, journal line, owner card. */
  sink: KnowledgeGateSink;
  /** Used when the caller passes no `thresholdDrop` (architecture: 5 points). */
  defaultThresholdDrop?: number;
}

export interface KnowledgeGate {
  /** The hook: call it after `rule.approved` / `skill.promoted` / `page.published`. */
  onKnowledgePublished(input: KnowledgeGateInput): Promise<KnowledgeGateOutcome>;
}

/** A criterion that scores 0 on a hallucination check fails at once. */
export function hallucinationFromScores(tasks: readonly EvalTaskScore[]): { taskSlug: string } | null {
  for (const task of tasks) {
    for (const [name, points] of Object.entries(task.criteria)) {
      if (HALLUCINATION_CRITERION_PATTERN.test(name) && points <= 0) return { taskSlug: task.taskSlug };
    }
  }
  return null;
}

/** The pure half of the gate: two runs in, one verdict out. */
export function decideKnowledgeGateVerdict(input: {
  hallucinationTaskSlug?: string | null;
  final: EvalRunRecord;
  /**
   * True when the repeat run ran. A drop suspected but not repeated is not a
   * rollback — the whole point of the repeat (architecture §4.2 step 7).
   */
  repeated: boolean;
  delta: number | null;
}): { verdict: KnowledgeGateVerdict; reason: string } {
  if (input.hallucinationTaskSlug) {
    return {
      verdict: "rollback",
      reason: `hallucination on reference task "${input.hallucinationTaskSlug}"; rolled back at once`,
    };
  }
  if (input.final.verdict === "regress") {
    return {
      verdict: "rollback",
      reason: `regression confirmed by the repeat run (delta ${formatDelta(input.delta)}): ${input.final.verdictReason ?? "do not promote"}`,
    };
  }
  if (input.final.verdict === "error") {
    // The judge could not judge (baseline gone). Keeping is the safe side:
    // an automatic rollback on an unavailable baseline would drop good rules.
    return { verdict: "keep", reason: `not judged: ${input.final.verdictReason ?? input.final.error ?? "judge error"}` };
  }
  if (input.final.verdict === null) {
    return { verdict: "keep", reason: `kept without comparison: ${input.final.verdictReason ?? "no baseline run"}` };
  }
  if (input.repeated) {
    return { verdict: "keep", reason: `suspected regression did not repeat: ${input.final.verdictReason ?? "within threshold"}` };
  }
  return { verdict: "keep", reason: input.final.verdictReason ?? `delta ${formatDelta(input.delta)} within threshold` };
}

function formatDelta(delta: number | null): string {
  return delta === null ? "n/a" : `${delta} pts`;
}

export function createKnowledgeGate(deps: KnowledgeGateDeps): KnowledgeGate {
  /**
   * The content of the published item is the answer the judge reads for every
   * reference task of the role: the question is "does the caste still answer
   * as well with this rule delivered?", and the rule is the only thing that
   * changed. A task without an answer scores zero, which the threshold sees.
   */
  async function answersFor(companyId: string, role: string, content: string): Promise<Record<string, string>> {
    const tasks: EvalTaskRow[] = await deps.evals.loadTasks(companyId, role);
    const answers: Record<string, string> = {};
    for (const task of tasks) answers[task.slug] = content;
    return answers;
  }

  async function onKnowledgePublished(input: KnowledgeGateInput): Promise<KnowledgeGateOutcome> {
    if (typeof input.slug !== "string" || input.slug.trim().length === 0) {
      throw new KnowledgeGateError("gate_subject_required", "slug is required");
    }
    if (typeof input.role !== "string" || input.role.trim().length === 0) {
      throw new KnowledgeGateError("gate_role_required", "role is required (the caste the judge runs for)");
    }
    const subjectKind = subjectKindForTrigger(input.trigger);
    const answers = await answersFor(input.companyId, input.role, input.content);
    const thresholdDrop = input.thresholdDrop ?? deps.defaultThresholdDrop;
    // The baseline may be absent: the first gate run of an item is then kept
    // unconditionally, and the run itself becomes the next gate's baseline.
    const baselineRunId = input.baselineRunId ?? null;

    // 1. The first judge run. Exactly one run is spent when nothing is wrong.
    const first = await deps.evals.runEval({
      companyId: input.companyId,
      role: input.role,
      subject: input.slug,
      subjectKind,
      subjectRef: input.slug,
      answers,
      baselineRunId,
      thresholdDrop,
    });

    // 2. A hallucination is a rollback without the repeat.
    const hallucination =
      input.hallucination?.taskSlug ?? hallucinationFromScores(first.run.scores?.tasks ?? [])?.taskSlug ?? null;

    // 3. Otherwise the repeat the threshold asked for — the second and last run.
    const confirm = !hallucination && first.needsConfirm ? await deps.evals.runConfirmation(first.run.id, answers) : null;
    const final = confirm?.run ?? first.run;

    // 4. The delta the journal records: points lost against the baseline.
    const baseline = baselineRunId ? await deps.evals.getRun(input.companyId, baselineRunId) : null;
    const delta =
      baseline?.scores && final.scores ? Math.round((baseline.scores.scorePercent - final.scores.scorePercent) * 10) / 10 : null;

    const decision = decideKnowledgeGateVerdict({
      hallucinationTaskSlug: hallucination,
      final,
      repeated: confirm !== null,
      delta,
    });

    // 5. The journal line first: it is the provenance of what follows.
    await deps.sink.recordJournal({
      nestId: input.nestId,
      itemRef: input.itemRef,
      subjectKind,
      subjectRef: input.slug,
      evalRunId: final.id,
      delta,
      verdict: decision.verdict,
      trigger: input.trigger,
      reason: decision.reason,
      ownerNotice: decision.verdict === "rollback",
    });

    // 6. Roll back, then tell the owner after the fact.
    let rolledBack = false;
    let ownerNotified = false;
    if (decision.verdict === "rollback") {
      await deps.sink.rollback({
        nestId: input.nestId,
        itemRef: input.itemRef,
        targetRevisionId: input.rollbackToRevisionId,
        changeSummary: `myrmidon evals gate: ${decision.reason}`,
        actor: input.actor,
        evalRunId: final.id,
        delta,
      });
      rolledBack = true;
      await deps.sink.notifyOwner({
        nestId: input.nestId,
        itemRef: input.itemRef,
        slug: input.slug,
        subjectKind,
        verdict: decision.verdict,
        reason: decision.reason,
        evalRunId: final.id,
        delta,
      });
      ownerNotified = true;
    }

    return {
      verdict: decision.verdict,
      reason: decision.reason,
      runId: final.id,
      firstRunId: first.run.id,
      confirmRunId: confirm?.run.id ?? null,
      delta,
      judgeRuns: confirm ? 2 : 1,
      rolledBack,
      ownerNotified,
    };
  }

  return { onKnowledgePublished };
}
/**
 * The knowledge module as the gate sees it: exactly the three operations the
 * gate performs. Structural, so `evals` never imports `knowledge` (the
 * dependency runs one way: knowledge → evals types only).
 */
export interface KnowledgeGateModulePort {
  rollback(
    itemRef: string,
    actor: KnowledgeGateActor,
    input: { targetRevisionId: string; changeSummary?: string | null },
  ): Promise<unknown>;
  recordGateJournal(
    itemRef: string,
    actor: KnowledgeGateActor,
    input: {
      subjectKind: string;
      subjectRef: string;
      evalRunId: string;
      delta: number | null;
      verdict: KnowledgeGateVerdict;
      trigger?: string | null;
      reason?: string | null;
      ownerNotice?: boolean;
    },
  ): Promise<void>;
}

export interface KnowledgeGateSinkOptions {
  /** The actor recorded on the rollback and the journal line. */
  actor: KnowledgeGateActor;
  /**
   * The owner card channel. Absent means journal-only: the line already
   * carries `owner_notice`, and the board renders the card from the journal
   * (K-2). Tests inject a recorder to assert the card was posted.
   */
  notifyOwner?(input: KnowledgeGateOwnerNotice): Promise<void>;
}

/** The evals-system actor on the wire: the judge, not a human. */
export const KNOWLEDGE_GATE_ACTOR_ID = "myrmidon-evals-gate";

export function createKnowledgeGateSink(
  module: KnowledgeGateModulePort,
  options: KnowledgeGateSinkOptions,
): KnowledgeGateSink {
  return {
    async rollback(input: KnowledgeGateRollbackRequest): Promise<void> {
      await module.rollback(input.itemRef, input.actor, {
        targetRevisionId: input.targetRevisionId,
        changeSummary: input.changeSummary,
      });
    },
    async recordJournal(input: KnowledgeGateJournalEntry): Promise<void> {
      await module.recordGateJournal(input.itemRef, options.actor, {
        subjectKind: input.subjectKind,
        subjectRef: input.subjectRef,
        evalRunId: input.evalRunId,
        delta: input.delta,
        verdict: input.verdict,
        trigger: input.trigger,
        reason: input.reason,
        ownerNotice: input.ownerNotice,
      });
    },
    async notifyOwner(input: KnowledgeGateOwnerNotice): Promise<void> {
      await options.notifyOwner?.(input);
    },
  };
}