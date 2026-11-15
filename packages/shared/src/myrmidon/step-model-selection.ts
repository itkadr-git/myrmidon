// Model selection for a heartbeat run. This module is deliberately pure: callers
// provide the already-authorized company/caste rules and the agent fallback.
// Secrets and provider credentials are never part of a selection snapshot.
import { z } from "zod";

export const STEP_MODEL_CLASSES = [
  "review",
  "acceptance",
  "decomposition",
  "execution",
  "background",
] as const;
export const stepModelClassSchema = z.enum(STEP_MODEL_CLASSES);
export type StepModelClass = z.infer<typeof stepModelClassSchema>;

export const stepModelSelectionSchema = z.object({
  stepClass: stepModelClassSchema,
  modelGroup: z.string().min(1).nullable(),
  model: z.string().min(1),
  reason: z.enum(["caste_rule", "company_rule", "agent_fallback"]),
  resolverVersion: z.literal("step-model-v1"),
}).strict();
export type StepModelSelection = z.infer<typeof stepModelSelectionSchema>;

export type StepModelRule = {
  modelGroup?: string | null;
  group?: string | null;
  model?: string | null;
};

export type StepModelResolverInput = {
  stepClass: StepModelClass;
  casteRule?: StepModelRule | null;
  companyRule?: StepModelRule | null;
  agentModel: string;
  modelGroups?: Record<string, string | null | undefined> | null;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function ruleGroup(rule: StepModelRule | null | undefined): string | null {
  return nonEmpty(rule?.modelGroup) ?? nonEmpty(rule?.group);
}

function ruleModel(rule: StepModelRule | null | undefined): string | null {
  return nonEmpty(rule?.model);
}

/** Resolve once, before adapter dispatch. The returned object is safe to persist. */
export function resolveStepModelSelection(input: StepModelResolverInput): StepModelSelection {
  const agentModel = nonEmpty(input.agentModel);
  if (!agentModel) throw new Error("step_model_agent_fallback_missing");

  const usableRule = (rule: StepModelRule | null | undefined) =>
    ruleGroup(rule) || ruleModel(rule) ? rule : null;
  const casteRule = usableRule(input.casteRule);
  const companyRule = usableRule(input.companyRule);
  const selectedRule = casteRule ?? companyRule ?? null;
  const reason = casteRule ? "caste_rule" : companyRule ? "company_rule" : "agent_fallback";
  const group = ruleGroup(selectedRule);
  const model = ruleModel(selectedRule) ?? (group ? nonEmpty(input.modelGroups?.[group]) ?? group : null) ?? agentModel;

  return stepModelSelectionSchema.parse({
    stepClass: input.stepClass,
    modelGroup: group,
    model,
    reason,
    resolverVersion: "step-model-v1",
  });
}

export function parseStepModelSelection(value: unknown): StepModelSelection | null {
  const result = stepModelSelectionSchema.safeParse(value);
  return result.success ? result.data : null;
}
