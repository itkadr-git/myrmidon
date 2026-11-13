// packages/shared/src/myrmidon-model-group-rules.ts
//
// myrmidon(1.8 MODEL-BY-STEP, OPE-12997): company model-group rules — the
// table step class → model group the owner arranges in the board settings,
// with optional per-caste overrides.
//
// The MODEL-BY-STEP epic (see server/src/myrmidon/run-step-class.ts,
// OPE-12996) classifies every heartbeat run into one of five step classes:
// review, acceptance, decomposition, execution, background. This module is
// the settings contract of the NEXT layer: for each step class the owner of a
// company picks the LiteLLM model group the run uses, and each caste of the
// company may override the company-wide rule. The runtime consumer (the model
// lookup at run start) is deliberately OUT of this scope — this module only
// defines what the settings API stores and returns.
//
// Pure data and pure functions only — no database access, no env:
//
//  - `RUN_STEP_CLASSES`: the epic's five classes, in ladder order (highest
//    priority first) — the same list the classifier exports.
//  - `companyModelGroupRuleSchema`: one rule row's wire shape. `scope.casteKey`
//    null (or absent) is the company-wide rule; a caste key makes it a caste
//    override for one caste of the same company.
//  - `saveCompanyModelGroupRulesSchema`: the PUT body — the full rule table
//    of a company in one save (the owner edits a small table, per-row PATCHes
//    would only multiply the failure modes).
//  - `resolveModelGroupForStep`: the pure precedence function. The caste
//    override wins, then the company rule, then null — an unset class must
//    read as "inherit whatever the run uses today", never as an empty group.
//  - `validateModelGroupRules`: catalog validation — every `modelGroup` must
//    be a group the gateway catalog offers, so a typo is refused at save time
//    instead of failing runs later.
//
// The caste key vocabulary is the caste directory's (`CASTE_KEY_PATTERN`); the
// API layer checks that the caste exists in the company, the schema here keeps
// only the shape.

import { z } from "zod";
import { CASTE_KEY_PATTERN } from "./myrmidon-castes.js";

/** The five epic step classes, highest priority first (OPE-12996). */
export const RUN_STEP_CLASSES = [
  "review",
  "acceptance",
  "decomposition",
  "execution",
  "background",
] as const;

export type RunStepClass = (typeof RUN_STEP_CLASSES)[number];

/** Longest accepted LiteLLM model group name. */
export const MODEL_GROUP_RULE_MAX_GROUP_CHARS = 128;

/** Most rules one save may carry: 5 classes × (1 company + 200 castes) is far above real use. */
export const MODEL_GROUP_RULE_MAX_RULES = 1024;

/** One rule: a step class, the group to use, and whose rule it is. */
export const companyModelGroupRuleSchema = z
  .object({
    /** The classified step the rule applies to. */
    stepClass: z.enum(RUN_STEP_CLASSES),
    /**
     * The LiteLLM model group (`model_name` of the gateway) the step uses.
     * Validated against the live catalog by the API layer.
     */
    modelGroup: z.string().trim().min(1).max(MODEL_GROUP_RULE_MAX_GROUP_CHARS),
    /**
     * null = the company-wide rule for the step class; a caste key = the
     * override for that one caste. The API layer checks the caste exists.
     */
    casteKey: z
      .string()
      .trim()
      .toLowerCase()
      .regex(CASTE_KEY_PATTERN)
      .nullable()
      .optional(),
  })
  .strict();

export type CompanyModelGroupRule = z.infer<typeof companyModelGroupRuleSchema>;

/** Body of PUT /api/myrmidon/companies/:companyId/model-group-rules. */
export const saveCompanyModelGroupRulesSchema = z
  .object({
    rules: z.array(companyModelGroupRuleSchema).max(MODEL_GROUP_RULE_MAX_RULES),
  })
  .strict();

export type SaveCompanyModelGroupRulesInput = z.infer<
  typeof saveCompanyModelGroupRulesSchema
>;

/** One rule as the API answers it. */
export interface CompanyModelGroupRuleView extends CompanyModelGroupRule {
  updatedAt: string;
}

/** GET /api/myrmidon/companies/:companyId/model-group-rules answer. */
export interface CompanyModelGroupRulesView {
  companyId: string;
  rules: CompanyModelGroupRuleView[];
  /** The group names the gateway catalog currently offers (validation basis). */
  availableGroups: string[];
}

/** Action of the company activity log entry a save writes. */
export const MODEL_GROUP_RULES_UPDATED_ACTION = "company.model_group_rules.updated";

/** The normalized `(casteKey, stepClass)` scope key of one rule. */
export type RuleScopeKey = string;

/** Internal scope key: caste first so rules group by caste in maps. */
export function ruleScopeKey(rule: {
  casteKey?: string | null;
  stepClass: string;
}): RuleScopeKey {
  return `${rule.casteKey ?? ""}\u0000${rule.stepClass}`;
}

/**
 * True when two rules in one save collide: same caste scope (null counts as
 * its own scope) and same step class. The API layer refuses such a body —
 * the precedence rules below assume one rule per scope.
 */
export function hasDuplicateModelGroupRules(
  rules: readonly CompanyModelGroupRule[],
): boolean {
  const seen = new Set<RuleScopeKey>();
  for (const rule of rules) {
    const key = ruleScopeKey(rule);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * The group a step uses: the caste's override, else the company rule, else
 * null ("no rule — the run keeps its current model selection"). Pure and
 * total; unknown caste keys simply miss both lookups.
 */
export function resolveModelGroupForStep(
  rules: readonly CompanyModelGroupRule[],
  stepClass: string,
  casteKey?: string | null,
): string | null {
  if (casteKey) {
    const override = rules.find(
      (rule) => rule.casteKey === casteKey && rule.stepClass === stepClass,
    );
    if (override) return override.modelGroup;
  }
  const company = rules.find(
    (rule) => !rule.casteKey && rule.stepClass === stepClass,
  );
  return company?.modelGroup ?? null;
}

/**
 * Catalog validation: every rule's group must be a group the gateway offers.
 * Returns the unknown group names, in first-seen order; empty = valid. An
 * empty catalog validates nothing (the API layer decides whether saving is
 * allowed against an unreachable gateway).
 */
export function unknownModelGroupsInRules(
  rules: readonly CompanyModelGroupRule[],
  availableGroups: readonly string[],
): string[] {
  const known = new Set(availableGroups);
  const unknown: string[] = [];
  for (const rule of rules) {
    if (!known.has(rule.modelGroup) && !unknown.includes(rule.modelGroup)) {
      unknown.push(rule.modelGroup);
    }
  }
  return unknown;
}
