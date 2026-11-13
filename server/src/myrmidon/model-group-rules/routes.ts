// server/src/myrmidon/model-group-rules/routes.ts
//
// myrmidon(1.8 MODEL-BY-STEP, OPE-12997): the settings API of the company
// model-group rules.
//
//   GET /api/myrmidon/companies/:companyId/model-group-rules   (company access)
//   PUT /api/myrmidon/companies/:companyId/model-group-rules   (board only)
//
// GET answers the stored rules plus `availableGroups` — the LiteLLM model
// group names the gateway currently offers — so the editor can validate while
// editing and show why a save would be refused.
//
// PUT replaces the whole rule table (the owner edits a small table; a save
// carries exactly what the screen shows). The service validates before the
// write:
//   - every group must be in the gateway catalog (`model_group_unknown`);
//   - every caste key must exist in THIS company (`caste_unknown`), so a rule
//     can never reach another company's castes;
//   - no duplicate (caste scope, step class) pairs (`rule_duplicate`);
//   - an unreachable gateway refuses the save (`model_group_catalog_unavailable`)
//     instead of storing rules nobody can verify.
// Every successful save writes one activity-log entry for the company.

import { Router } from "express";
import {
  saveCompanyModelGroupRulesSchema,
  MODEL_GROUP_RULES_UPDATED_ACTION,
  ruleScopeKey,
  unknownModelGroupsInRules,
  type CompanyModelGroupRule,
  type CompanyModelGroupRuleView,
  type CompanyModelGroupRulesView,
  type SaveCompanyModelGroupRulesInput,
} from "@myrmidon/shared";
import type { Db } from "@myrmidon/db";
import { badRequest } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import {
  createModelGroupRulesStore,
  ruleViewOf,
  type ModelGroupRulesStore,
} from "./store.js";
/** The LiteLLM group names the gateway offers to this company. */
export interface ModelGroupCatalogPort {
  listGroups(companyId: string): Promise<string[]>;
}
export interface ModelGroupRulesRoutesDeps {
  catalog: ModelGroupCatalogPort;
  store?: ModelGroupRulesStore;
  recordActivity?: (input: Parameters<typeof logActivity>[1]) => Promise<unknown>;
}

export function modelGroupRulesRoutes(db: Db, deps: ModelGroupRulesRoutesDeps): Router {
  const router = Router();
  const store = deps.store ?? createModelGroupRulesStore(db);
  router.get("/myrmidon/companies/:companyId/model-group-rules", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await store.list(companyId);
    let availableGroups: string[] = [];
    try {
      availableGroups = await deps.catalog.listGroups(companyId);
    } catch {
      // The catalog is presentation/validation aid: a read still answers the
      // stored rules when the gateway is down; the editor marks validation
      // unavailable instead of pretending the catalog is empty.
      availableGroups = [];
    }
    const rules: CompanyModelGroupRuleView[] = rows.map(ruleViewOf);
    const body: CompanyModelGroupRulesView = { companyId, rules, availableGroups };
    res.json(body);
  });

  router.put(
    "/myrmidon/companies/:companyId/model-group-rules",
    validate(saveCompanyModelGroupRulesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      // `validate` already parsed the body: this is the schema-checked input.
      const rules = (req.body as SaveCompanyModelGroupRulesInput).rules;
      const scopeKeys = new Set<string>();
      for (const rule of rules) {
        const key = ruleScopeKey(rule);
        if (scopeKeys.has(key)) {
          throw badRequest(
            `duplicate rule for step class "${rule.stepClass}" in the same scope`,
            { code: "rule_duplicate" },
          );
        }
        scopeKeys.add(key);
      }
      const availableGroups = await deps.catalog.listGroups(companyId).catch(() => {
        throw badRequest(
          "the model group catalog is unavailable; save refused",
          { code: "model_group_catalog_unavailable" },
        );
      });
      const unknown = unknownModelGroupsInRules(rules, availableGroups);
      if (unknown.length > 0) {
        throw badRequest(
          `unknown model groups: ${unknown.join(", ")}`,
          { code: "model_group_unknown" },
        );
      }
      const casteKeys: string[] = [
        ...new Set(
          rules
            .map((rule: CompanyModelGroupRule) => rule.casteKey)
            .filter((key): key is string => Boolean(key)),
        ),
      ];
      const existing = await store.existingCasteKeys(companyId, casteKeys);
      const missing = casteKeys.filter((key) => !existing.has(key));
      if (missing.length > 0) {
        throw badRequest(
          `unknown castes: ${missing.join(", ")}`,
          { code: "caste_unknown" },
        );
      }
      const rows = await store.replaceAll(companyId, rules);
      const actor = getActorInfo(req);
      await (deps.recordActivity ?? ((input) => logActivity(db, input)))({
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: MODEL_GROUP_RULES_UPDATED_ACTION,
        entityType: "model_group_rules",
        entityId: companyId,
        details: { count: rows.length },
      });
      const views: CompanyModelGroupRuleView[] = rows.map(ruleViewOf);
      const body: CompanyModelGroupRulesView = { companyId, rules: views, availableGroups };
      res.json(body);
    },
  );

  return router;
}
