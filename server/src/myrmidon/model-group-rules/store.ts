// server/src/myrmidon/model-group-rules/store.ts
//
// myrmidon(1.8 MODEL-BY-STEP, OPE-12997): the database side of the company
// model-group rules — the step-class → model-group table of one company with
// per-caste overrides.
//
// Storage shape (packages/db/src/schema/company_model_group_rules.ts):
// one row per rule, `(company_id, caste_key, step_class)` unique with
// `caste_key = NULL` on the company-wide rule. The save is the whole table:
// rows the PUT body misses are deleted, so the owner's editor writes what it
// shows — no stale rows behind a smaller table.
//
// Company scoping: every statement filters by `company_id`; a caste key is
// validated against the same company's `agent_castes` before any write, so a
// company can never rule another company's castes.

import { asc, eq } from "drizzle-orm";
import { agentCastes, companyModelGroupRules, type Db } from "@myrmidon/db";
import type { CompanyModelGroupRule, CompanyModelGroupRuleView } from "@myrmidon/shared";

export interface ModelGroupRuleRow {
  casteKey: string | null;
  stepClass: string;
  modelGroup: string;
  updatedAt: string;
}

export interface ModelGroupRulesStore {
  /** The company's rules, company-wide rows first, then by caste and class. */
  list(companyId: string): Promise<ModelGroupRuleRow[]>;
  /** The caste keys of the company that exist in the caste directory. */
  existingCasteKeys(companyId: string, keys: readonly string[]): Promise<Set<string>>;
  /** Replaces the company's rule table in one transaction. */
  replaceAll(
    companyId: string,
    rules: readonly CompanyModelGroupRule[],
  ): Promise<ModelGroupRuleRow[]>;
}

function viewOf(row: {
  casteKey: string | null;
  stepClass: string;
  modelGroup: string;
  updatedAt: Date;
}): ModelGroupRuleRow {
  return {
    casteKey: row.casteKey,
    stepClass: row.stepClass,
    modelGroup: row.modelGroup,
    updatedAt: row.updatedAt.toISOString(),
  };
}


export function createModelGroupRulesStore(db: Db): ModelGroupRulesStore {
  return {
    async list(companyId) {
      const rows = await db
        .select({
          casteKey: companyModelGroupRules.casteKey,
          stepClass: companyModelGroupRules.stepClass,
          modelGroup: companyModelGroupRules.modelGroup,
          updatedAt: companyModelGroupRules.updatedAt,
        })
        .from(companyModelGroupRules)
        .where(eq(companyModelGroupRules.companyId, companyId))
        .orderBy(
          asc(companyModelGroupRules.casteKey),
          asc(companyModelGroupRules.stepClass),
        );
      return rows.map(viewOf);
    },

    async existingCasteKeys(companyId, keys) {
      const found = new Set<string>();
      for (const key of keys) {
        const rows = await db
          .select({ key: agentCastes.key })
          .from(agentCastes)
          .where(and(eq(agentCastes.companyId, companyId), eq(agentCastes.key, key)))
          .limit(1);
        if (rows.length > 0) found.add(key);
      }
      return found;
    },

    async replaceAll(companyId, rules) {
      await db.transaction(async (tx) => {
        await tx
          .delete(companyModelGroupRules)
          .where(eq(companyModelGroupRules.companyId, companyId));
        if (rules.length > 0) {
          await tx.insert(companyModelGroupRules).values(
            rules.map((rule) => ({
              companyId,
              casteKey: rule.casteKey ?? null,
              stepClass: rule.stepClass,
              modelGroup: rule.modelGroup,
            })),
          );
        }
      });
      return this.list(companyId);
    },
  };
}

/** The wire view of one stored row. */
export function ruleViewOf(row: ModelGroupRuleRow): CompanyModelGroupRuleView {
  return {
    stepClass: row.stepClass as CompanyModelGroupRuleView["stepClass"],
    modelGroup: row.modelGroup,
    casteKey: row.casteKey,
    updatedAt: row.updatedAt,
  };
}
