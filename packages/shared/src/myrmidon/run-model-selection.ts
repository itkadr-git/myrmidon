// packages/shared/src/myrmidon/run-model-selection.ts
//
// myrmidon(1.8 MODEL-BY-STEP, OPE-12999): contract for the model-selection
// snapshot a run carries in `heartbeat_runs.context_snapshot.modelSelection`.
// The snapshot is written by the run picker (issue OPE-12998) and is the ONLY
// source of truth for the cost class of a run's spend: cost reports group by
// it, and runs recorded before the snapshot existed count as the "unknown"
// step class. Base price calculation is intentionally not touched here.

export const RUN_MODEL_SELECTION_SNAPSHOT_SCHEMA = "paperclip.run_model_selection.v1";

/** Step class recorded for runs that predate the model-selection snapshot. */
export const UNKNOWN_STEP_CLASS = "unknown";

export const RUN_MODEL_SELECTION_RULE_SOURCES = [
  "step_importance",
  "caste",
  "fallback",
] as const;

export type RunModelSelectionRuleSource = (typeof RUN_MODEL_SELECTION_RULE_SOURCES)[number];

export interface RunModelSelectionSnapshot {
  schema: string;
  /** Cost class of the step, e.g. "reviewer" / "background". */
  stepClass: string;
  /** Model group resolved for the class, e.g. "strong" / "economy". */
  modelGroup: string;
  /** Concrete model the run was started with, when known. */
  model: string | null;
  /** Which rule family selected the group. */
  ruleSource: RunModelSelectionRuleSource | string | null;
  /** Human-readable label of the applied rule (shown on the run card). */
  ruleLabel: string | null;
  resolvedAt: string | null;
}

/**
 * Tolerant reader: accepts any object shaped like a model-selection snapshot
 * (schema key optional so pre-v1 writers keep working) and returns null for
 * legacy snapshots without one.
 */
export function readRunModelSelection(
  contextSnapshot: Record<string, unknown> | null | undefined,
): RunModelSelectionSnapshot | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object") return null;
  const raw = contextSnapshot.modelSelection ?? contextSnapshot.stepModel ?? contextSnapshot.stepModelSnapshot;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const stepClass = typeof source.stepClass === "string" && source.stepClass.trim().length > 0
    ? source.stepClass.trim()
    : null;
  const modelGroup = typeof source.modelGroup === "string" && source.modelGroup.trim().length > 0
    ? source.modelGroup.trim()
    : null;
  if (!stepClass || !modelGroup) return null;
  return {
    schema: typeof source.schema === "string" ? source.schema : RUN_MODEL_SELECTION_SNAPSHOT_SCHEMA,
    stepClass,
    modelGroup,
    model: typeof source.model === "string" && source.model.length > 0 ? source.model : null,
    ruleSource: typeof source.ruleSource === "string" && source.ruleSource.length > 0
      ? source.ruleSource
      : typeof source.reason === "string" && source.reason.length > 0
        ? source.reason
        : null,
    ruleLabel: typeof source.ruleLabel === "string" && source.ruleLabel.length > 0 ? source.ruleLabel : null,
    resolvedAt: typeof source.resolvedAt === "string" && source.resolvedAt.length > 0 ? source.resolvedAt : null,
  };
}
