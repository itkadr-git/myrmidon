// packages/shared/src/myrmidon-budget-projection.ts
//
// myrmidon(1.7-BUDGET-CONFIG-C): the shared contract of the LiteLLM budget
// projection — the limits the board owns and projects into the gateway.
//
// The hierarchy the epic names (nest → caste → foraging → ticket) is stored
// by this part as a flat, level-tagged set of limit rows held per company in
// the instance-settings JSON column (the no-migration pattern the STT module
// uses). Part A (the hierarchy model) will later own the authoring surface;
// this contract stays additive so part A can read and write the same rows
// without a migration.
//
// Pure data and pure functions only: the server, the sweep and the tests read
// one source of truth:
//
//  - BudgetProjectionLevel: one of "nest" | "caste" | "foraging" | "ticket".
//  - BudgetProjectionLimit: { level, scopeId, amountUsd, periodHours, mode }.
//    `mode` is the epic's hard/soft choice ("block" — the gateway refuses;
//    "soft" — the board pauses and cards the owner).
//  - The signal-only global switch: on by default (the epic default), off
//    only by an explicit owner action — while it is on the projection keeps
//    every gateway budget soft; the hard mode is written only when the owner
//    turned signal-only off AND the row's mode is "block".
//  - The stored document additionally carries `projected` — what the board
//    last WROTE to the gateway per target. The three-way comparison
//    (board vs projected vs gateway) is what tells "the board changed the
//    limit" (push it) from "someone edited the gateway by hand" (signal it,
//    never silently overwrite).
//  - One stable tag naming convention so the sync finds its objects without
//    storing gateway ids: the budget tag of a scope is `myrm-<level>-<scope>`.

import { z } from "zod";

/** The `instance_settings.general` key holding the per-company documents map. */
export const BUDGET_PROJECTION_COMPANIES_KEY = "myrmidonBudgetProjectionCompanies";

/** Levels of the epic's hierarchy, outermost first. */
export const BUDGET_PROJECTION_LEVELS = ["nest", "caste", "foraging", "ticket"] as const;
export type BudgetProjectionLevel = (typeof BUDGET_PROJECTION_LEVELS)[number];

/** What the gateway does when the limit is reached. */
export const BUDGET_PROJECTION_MODES = ["block", "soft"] as const;
export type BudgetProjectionMode = (typeof BUDGET_PROJECTION_MODES)[number];

/** Where an effective value came from: stored settings, env, or the default. */
export type BudgetProjectionSettingSource = "settings" | "env" | "default";

/** One projected limit row. */
export const budgetProjectionLimitSchema = z
  .object({
    /** Hierarchy level of the row. */
    level: z.enum(BUDGET_PROJECTION_LEVELS),
    /** Stable scope key: company id (nest), caste key (caste), foraging pass key, or issue id (ticket). */
    scopeId: z.string().min(1).max(200),
    /** Ceiling in whole US dollars; 0 = remove the projection. */
    amountUsd: z.number().int().min(0).max(10_000_000),
    /** Rolling window in hours; 720 = a 30-day month. */
    periodHours: z.number().int().min(1).max(8760).default(720),
    /** block = the gateway blocks; soft = the board signals only. */
    mode: z.enum(BUDGET_PROJECTION_MODES).default("soft"),
  })
  .strict();
export type BudgetProjectionLimit = z.infer<typeof budgetProjectionLimitSchema>;

/** The public PUT body (what the UI sends); `projected` is internal. */
export const budgetProjectionSettingsSchema = z
  .object({
    /** The signal-only global switch: on by default (epic default). */
    signalOnly: z.boolean().default(true),
    /** Master switch of the projection itself. */
    enabled: z.boolean().default(false),
    limits: z.array(budgetProjectionLimitSchema).default([]),
    /** The sweep interval the company chose; null = the default (30 s). */
    sweepIntervalSec: z.number().int().min(10).max(3600).nullable().default(null),
  })
  .strict();
export type BudgetProjectionSettings = z.infer<typeof budgetProjectionSettingsSchema>;

/**
 * The stored document: the public shape plus `projected`, the amounts the
 * board last wrote into the gateway, keyed by target
 * ("tag:<tag>" / "key:<alias>"). Managed by the sync only.
 */
export const budgetProjectionStoredSchema = budgetProjectionSettingsSchema.extend({
  projected: z.record(z.string(), z.number().int().min(0).nullable()).default({}),
});
export type BudgetProjectionStoredSettings = z.infer<typeof budgetProjectionStoredSchema>;

/** The stored document, or the implicit default (off, empty) when absent. */
export function normalizeBudgetProjectionSettings(raw: unknown): BudgetProjectionStoredSettings {
  const parsed = budgetProjectionStoredSchema.safeParse(raw);
  if (parsed.success) {
    return { ...parsed.data, limits: [...parsed.data.limits], projected: { ...parsed.data.projected } };
  }
  return { signalOnly: true, enabled: false, limits: [], sweepIntervalSec: null, projected: {} };
}

/**
 * The gateway budget tag of one scope — the stable name the sync writes and
 * re-finds its objects by (LiteLLM budgets are keyed by tag).
 */
export function budgetProjectionTag(level: BudgetProjectionLevel, scopeId: string): string {
  const safe = scopeId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `myrm-${level}-${safe}`;
}
