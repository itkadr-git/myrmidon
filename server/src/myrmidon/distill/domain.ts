// server/src/myrmidon/distill/domain.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-5): the pure domain of the distiller v2.
// Knowledge grows out of closed tasks without a board copy (§4.5): raw material
// is selected by `completedAt`, one model pass classifies it into classes,
// `noise` is dropped silently, the rest arrives as knowledge suggestions —
// never as pages written directly. This file has no database and no I/O.

/** Distillation classes (§4.5). `noise` is dropped, never suggested. */
export const DISTILL_CLASSES = [
  "architecture_change",
  "decision",
  "runbook_step",
  "release_note",
  "glossary_term",
  "regulation_candidate",
  "skill_candidate",
  "noise",
] as const;
export type DistillClass = (typeof DISTILL_CLASSES)[number];

/** Sections allowed to auto-accept by settings (§6.2 K-5): glossary, releases, "how it was made". */
export const AUTO_ACCEPT_SECTIONS = ["glossary", "releases", "how-made"] as const;
export type AutoAcceptSection = (typeof AUTO_ACCEPT_SECTIONS)[number];

/** Proposal destination: a named section of the nest, plus an optional target slug. */
export interface DistillProposalTarget {
  section: AutoAcceptSection | "general";
  /** Existing item slug the proposal patches; null when it proposes a new page. */
  slug: string | null;
}

export interface DistillSourceRef {
  /** Same vocabulary as the knowledge store (`task`, `pr`, `issue`, `run`, `document`, `decision`). */
  kind: "task" | "pr" | "issue" | "run" | "document" | "decision";
  ref: string;
}

export interface DistillProposal {
  class: DistillClass;
  /** The suggestion body the curator cast will polish into final text. */
  body: string;
  rationale: string | null;
  target: DistillProposalTarget;
  sources: DistillSourceRef[];
  /** Task identifiers this proposal cites as evidence — "never one line per task":
   *  one patch quotes 1..10 tasks as proofs of a single claim (§4.5). */
  evidenceTaskRefs: string[];
}

/** The signal a pass reports about itself: budgets are signals, not pages. */
export interface DistillRunUsage {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface DistillBudget {
  /** Input-token budget for one pass — exceeding it is a signal, not a crash (§4.5). */
  maxInputTokens: number;
  /** Wall-clock budget for one pass in milliseconds. */
  maxDurationMs: number;
}

export interface DistillFilterReport {
  kept: DistillProposal[];
  droppedNoise: number;
  droppedLife: number;
  droppedUnsourced: number;
}

/** Default budget (§4.5 / §6.2 K-5): 1M input tokens and 30 minutes per pass. */
export const DEFAULT_DISTILL_BUDGET: DistillBudget = {
  maxInputTokens: 1_000_000,
  maxDurationMs: 30 * 60 * 1000,
};

/** One human-facing package holds at most 10 proposals (K-5 criterion). */
export const MAX_HUMAN_PACKAGE = 10;

/** The pass is silent below this noise share; a real distillation drops most raw material (§4.5). */
export const MIN_NOISE_SHARE = 0.6;

export function isDistillClass(value: unknown): value is DistillClass {
  return typeof value === "string" && (DISTILL_CLASSES as readonly string[]).includes(value);
}

export function isAutoAcceptSection(value: unknown): value is AutoAcceptSection {
  return typeof value === "string" && (AUTO_ACCEPT_SECTIONS as readonly string[]).includes(value);
}

/**
 * I-7: the `life` direction is a private contour. A source belongs to `life`
 * when its ref names a life direction segment (`life` as a path/word part, e.g.
 * a project named `fleet-life` or a ref containing `/life/`). The check is
 * deliberately lexical: refs are strings, and the distiller must not need the
 * board graph to enforce the boundary.
 */
export function isLifeSource(source: DistillSourceRef, lifePattern: RegExp = /(^|[^a-z])life([^a-z]|$)/i): boolean {
  return lifePattern.test(source.ref);
}

/** True when any cited source comes from the life direction. */
export function citesLifeSource(proposal: DistillProposal): boolean {
  return proposal.sources.some((source) => isLifeSource(source));
}

/**
 * The filter a pass applies before anything reaches the nest:
 * 1. `noise` is dropped silently (never suggested, never logged per item);
 * 2. proposals without at least one source are dropped (K-5 criterion);
 * 3. life-direction proposals are excluded from the general sections — they may
 *    only target the life-private section set, which K-5 does not auto-write
 *    at all, so in practice a life-citing proposal for a common section is
 *    dropped (I-7);
 * 4. the human package is capped at MAX_HUMAN_PACKAGE.
 */
export function filterProposals(proposals: DistillProposal[]): DistillFilterReport {
  let droppedNoise = 0;
  let droppedLife = 0;
  let droppedUnsourced = 0;
  const kept: DistillProposal[] = [];
  for (const proposal of proposals) {
    if (proposal.class === "noise") {
      droppedNoise += 1;
      continue;
    }
    if (proposal.sources.length < 1 || proposal.evidenceTaskRefs.length < 1) {
      droppedUnsourced += 1;
      continue;
    }
    if (citesLifeSource(proposal)) {
      droppedLife += 1;
      continue;
    }
    kept.push(proposal);
  }
  return { kept: kept.slice(0, MAX_HUMAN_PACKAGE), droppedNoise, droppedLife, droppedUnsourced };
}

/** The noise-share signal: below MIN_NOISE_SHARE the run is reported as suspicious, not retried. */
export function noiseShare(total: number, droppedNoise: number): number {
  if (total <= 0) return 0;
  return droppedNoise / total;
}

export function withinBudget(usage: DistillRunUsage, budget: DistillBudget): { ok: boolean; signals: string[] } {
  const signals: string[] = [];
  if (usage.inputTokens > budget.maxInputTokens) signals.push("token_budget_exceeded");
  if (usage.durationMs > budget.maxDurationMs) signals.push("time_budget_exceeded");
  return { ok: signals.length === 0, signals };
}

/** One patch cites 1..10 tasks as proofs (§4.5: never one line per task). */
export function validateEvidence(proposal: DistillProposal): string | null {
  if (proposal.evidenceTaskRefs.length < 1) return "a proposal must cite at least one task";
  if (proposal.evidenceTaskRefs.length > 10) return "a proposal may cite at most 10 tasks";
  if (proposal.sources.length < 1) return "a proposal must carry at least one source";
  return null;
}
