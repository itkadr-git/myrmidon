// server/src/myrmidon/model-group-rules/model-group-rules-api.myrmidon.test.ts
//
// myrmidon(1.8 MODEL-BY-STEP, OPE-12997): the settings API — access rules,
// request validation and the precedence of a caste rule over a company rule.
// Plain fakes: no database, no gateway. The store's suite
// (model-group-rules.db.myrmidon.test.ts) covers the rows against a real
// database.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { resolveModelGroupForStep, type CompanyModelGroupRule } from "@myrmidon/shared";
import { errorHandler } from "../../middleware/index.js";
import { modelGroupRulesRoutes, type ModelGroupCatalogPort } from "./routes.js";
import type { ModelGroupRuleRow, ModelGroupRulesStore } from "./store.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "33333333-3333-4333-8333-333333333333";

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
const outsider = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [OTHER_COMPANY] };
const agentActor = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: COMPANY_ID, keyId: "key-a" };

const base = `/api/myrmidon/companies/${COMPANY_ID}/model-group-rules`;

/** Catalog fake: knows two groups, refuses when the gateway is "down". */
function catalog(groups: string[] = ["strong", "economy"], down = false): ModelGroupCatalogPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listGroups(companyId: string) {
      calls.push(companyId);
      if (down) throw new Error("gateway down");
      return groups;
    },
  };
}

function app(actor: unknown, groups?: string[], down = false) {
  const cat = catalog(groups, down);
  const saved: Array<{ companyId: string; rules: ModelGroupRuleRow[] }> = [];
  const activity: Array<{ action: string; companyId: string }> = [];
  const store: ModelGroupRulesStore = {
    async list(companyId: string) {
      return saved.find((s) => s.companyId === companyId)?.rules ?? [];
    },
    async existingCasteKeys(companyId: string, keys: readonly string[]) {
      return new Set(keys.filter((key) => key !== "ghost"));
    },
    async replaceAll(
      companyId: string,
      rules: readonly CompanyModelGroupRule[],
    ) {
      saved.splice(0);
      const rows: ModelGroupRuleRow[] = rules.map((rule, i) => ({
        casteKey: rule.casteKey ?? null,
        stepClass: rule.stepClass,
        modelGroup: rule.modelGroup,
        updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }));
      saved.push({ companyId, rules: rows });
      return rows;
    },
  };
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    modelGroupRulesRoutes({} as never, {
      catalog: cat,
      store,
      recordActivity: async (entry) => {
        activity.push({ action: entry.action, companyId: entry.companyId });
      },
    }),
  );
  server.use(errorHandler);
  return { server, saved, activity, cat };
}

describe("myrmidon(1.8 MODEL-BY-STEP) routes: access", () => {
  it("denies another company on both routes (403, catalog untouched)", async () => {
    const { server, cat } = app(outsider);
    await request(server).get(base).expect(403);
    await request(server).put(base).send({ rules: [] }).expect(403);
    expect(cat.calls).toHaveLength(0);
  });

  it("lets an agent of the company read but not save", async () => {
    const { server, saved, cat } = app(agentActor);
    await request(server).get(base).expect(200);
    await request(server)
      .put(base)
      .send({ rules: [{ stepClass: "review", modelGroup: "strong" }] })
      .expect(403);
    expect(saved).toHaveLength(0);
    expect(cat.calls).toHaveLength(1);
  });

  it("lets a board member of the company read and save", async () => {
    const { server, saved } = app(member, ["strong", "economy"]);
    const put = await request(server)
      .put(base)
      .send({
        rules: [
          { stepClass: "review", modelGroup: "strong", casteKey: null },
          { stepClass: "execution", modelGroup: "economy", casteKey: "engineer" },
        ],
      })
      .expect(200);
    expect(put.body.rules).toHaveLength(2);
    expect(saved).toHaveLength(1);
  });
});

describe("myrmidon(1.8 MODEL-BY-STEP) routes: validation", () => {
  it("refuses an unknown model group with model_group_unknown", async () => {
    const { server } = app(member, ["strong"]);
    const res = await request(server)
      .put(base)
      .send({ rules: [{ stepClass: "review", modelGroup: "ghost-group" }] })
      .expect(400);
    expect(res.body.error).toContain("ghost-group");
    expect(res.body.code).toBe("model_group_unknown");
  });

  it("refuses an unknown caste with caste_unknown", async () => {
    const { server } = app(member, ["strong"]);
    const res = await request(server)
      .put(base)
      .send({
        rules: [{ stepClass: "review", modelGroup: "strong", casteKey: "ghost" }],
      })
      .expect(400);
    expect(res.body.error).toContain("ghost");
    expect(res.body.code).toBe("caste_unknown");
  });

  it("refuses a duplicate scope with rule_duplicate", async () => {
    const { server } = app(member, ["strong"]);
    const res = await request(server)
      .put(base)
      .send({
        rules: [
          { stepClass: "review", modelGroup: "strong", casteKey: null },
          { stepClass: "review", modelGroup: "strong", casteKey: null },
        ],
      })
      .expect(400);
    expect(res.body.error).toContain("duplicate");
    expect(res.body.code).toBe("rule_duplicate");
  });

  it("refuses a body that fails the schema with 400", async () => {
    const { server } = app(member, ["strong"]);
    await request(server)
      .put(base)
      .send({ rules: [{ stepClass: "deploy", modelGroup: "strong" }] })
      .expect(400);
    await request(server).put(base).send({ rules: "nope" }).expect(400);
    await request(server).put(base).send({}).expect(400);
  });

  it("refuses the save when the catalog is unreachable (fail closed)", async () => {
    const { server, saved } = app(member, [], true);
    const res = await request(server)
      .put(base)
      .send({ rules: [{ stepClass: "review", modelGroup: "strong" }] })
      .expect(400);
    expect(res.body.error).toContain("catalog is unavailable");
    expect(saved).toHaveLength(0);
  });

  it("answers GET with the stored rules and the available groups", async () => {
    const { server } = app(member, ["strong", "economy"]);
    const get = await request(server).get(base).expect(200);
    expect(get.body.companyId).toBe(COMPANY_ID);
    expect(get.body.availableGroups).toEqual(["strong", "economy"]);
    expect(get.body.rules).toEqual([]);
    expect(get.body.catalogUnavailable).toBe(false);
  });

  it("answers GET with stored rules and catalogUnavailable=true when gateway is down", async () => {
    const { server, saved } = app(member, [], true);
    saved.push({
      companyId: COMPANY_ID,
      rules: [
        {
          casteKey: null,
          stepClass: "review",
          modelGroup: "existing-strong",
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const get = await request(server).get(base).expect(200);
    expect(get.body.companyId).toBe(COMPANY_ID);
    expect(get.body.availableGroups).toEqual([]);
    expect(get.body.catalogUnavailable).toBe(true);
    expect(get.body.rules).toHaveLength(1);
    expect(get.body.rules[0].modelGroup).toBe("existing-strong");
  });

  it("allows PUT to retain or clear existing rules when catalog is unavailable", async () => {
    const { server, saved } = app(member, [], true);
    saved.push({
      companyId: COMPANY_ID,
      rules: [
        {
          casteKey: null,
          stepClass: "review",
          modelGroup: "existing-strong",
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const put = await request(server)
      .put(base)
      .send({ rules: [] })
      .expect(200);
    expect(put.body.rules).toHaveLength(0);
    expect(put.body.catalogUnavailable).toBe(true);
  });

  it("acceptance criteria: valid rule saved by owner returns from GET for company, can be overridden by caste, without affecting other companies", async () => {
    const { server, saved } = app(member, ["strong", "economy", "best"]);

    // 1. Owner saves company-wide rule and a caste override for the company
    const put = await request(server)
      .put(base)
      .send({
        rules: [
          { stepClass: "review", modelGroup: "strong", casteKey: null },
          { stepClass: "review", modelGroup: "best", casteKey: "reviewer" },
          { stepClass: "execution", modelGroup: "economy", casteKey: "engineer" },
        ],
      })
      .expect(200);

    expect(put.body.rules).toHaveLength(3);

    // 2. GET returns the saved rules for this company
    const get = await request(server).get(base).expect(200);
    expect(get.body.companyId).toBe(COMPANY_ID);
    expect(get.body.rules).toHaveLength(3);

    // 3. Caste override takes precedence for the caste while company rule applies to others
    expect(resolveModelGroupForStep(get.body.rules, "review", "reviewer")).toBe("best");
    expect(resolveModelGroupForStep(get.body.rules, "review", "engineer")).toBe("strong");
    expect(resolveModelGroupForStep(get.body.rules, "review", null)).toBe("strong");

    // 4. Other company is isolated in store and denied access
    expect(saved.every((entry) => entry.companyId === COMPANY_ID)).toBe(true);
    const outsiderApp = app(outsider, ["strong", "economy", "best"]);
    await request(outsiderApp.server).get(base).expect(403);
    await request(outsiderApp.server).put(base).send({ rules: [] }).expect(403);
  });
});

describe("myrmidon(1.8 MODEL-BY-STEP) precedence — caste over company", () => {
  it("resolving through the shared rule: the caste rule wins, others fall back", () => {
    const rules: CompanyModelGroupRule[] = [
      { stepClass: "review", modelGroup: "company-strong", casteKey: null },
      { stepClass: "review", modelGroup: "reviewer-best", casteKey: "reviewer" },
    ];
    expect(resolveModelGroupForStep(rules, "review", "reviewer")).toBe("reviewer-best");
    expect(resolveModelGroupForStep(rules, "review", "engineer")).toBe("company-strong");
    expect(resolveModelGroupForStep(rules, "review", null)).toBe("company-strong");
  });
});
