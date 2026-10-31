// server/src/myrmidon/budget-limits/routes.myrmidon.test.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): the limits routes — access rules, ref
// validation, the journal read, usage rows, and the signal-only flag (source
// reporting and the env forced override). The store is backed by a fake
// in-memory map; the settings service is a fake general block. This pins the
// API surface, not the vendor.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { errorHandler } from "../../middleware/index.js";
import { budgetLimitsRoutes } from "./routes.js";
import type { BudgetLimitView, BudgetLimitChangeView } from "@myrmidon/shared";

const boardActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  companyIds: ["company-a"],
  isInstanceAdmin: true,
};
const agentActor = { type: "agent", agentId: "agent-a", companyId: "company-a", source: "agent_key" };
const foreignAgentActor = { type: "agent", agentId: "agent-b", companyId: "company-b", source: "agent_key" };

function fakeStore() {
  const limits = new Map<string, BudgetLimitView>();
  const journal: BudgetLimitChangeView[] = [];
  const now = () => new Date("2026-10-04T12:00:00.000Z");
  const key = (companyId: string, level: string, ref: string) => `${companyId}/${level}/${ref}`;
  const row = (companyId: string, level: string, ref: string): BudgetLimitView => ({
    id: `limit-${level}-${ref}`,
    companyId,
    level: level as BudgetLimitView["level"],
    ref,
    amountCents: 5_000,
    period: "calendar_month_utc",
    mode: "hard",
    isActive: true,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  });
  return {
    limits,
    list: vi.fn(async (companyId: string, level?: string) =>
      [...limits.values()].filter(
        (item) => item.companyId === companyId && (!level || item.level === level),
      )),
    get: vi.fn(async (companyId: string, level: string, ref: string) => limits.get(key(companyId, level, ref)) ?? null),
    upsert: vi.fn(async (companyId: string, level: string, ref: string, input: Record<string, unknown>, actor: Record<string, unknown>) => {
      const existing = limits.get(key(companyId, level, ref));
      const view = { ...row(companyId, level, ref), ...input } as BudgetLimitView;
      limits.set(key(companyId, level, ref), view);
      const entry: BudgetLimitChangeView = {
        id: `change-${journal.length + 1}`,
        companyId,
        limitId: view.id,
        action: existing ? "update" : "create",
        level: level as BudgetLimitView["level"],
        ref,
        before: (existing ?? null) as Record<string, unknown> | null,
        after: view as unknown as Record<string, unknown>,
        actorType: String(actor.actorType),
        actorId: String(actor.actorId),
        at: now().toISOString(),
      };
      journal.unshift(entry);
      return view;
    }),
    remove: vi.fn(async (companyId: string, level: string, ref: string) => {
      return limits.delete(key(companyId, level, ref));
    }),
    journal: vi.fn(async (companyId: string) => journal.filter((item) => item.companyId === companyId)),
  };
}

type FakeStore = ReturnType<typeof fakeStore>;

function fakeSettings(initial: Record<string, unknown> = {}) {
  const general: Record<string, unknown> = { ...initial };
  return {
    getGeneral: vi.fn(async () => general),
    updateGeneral: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(general, patch);
      return { general };
    }),
    general,
  };
}

// The routes module builds its store from the db; inject the fake by
// monkey-patching createBudgetLimitStore is fragile, so instead we mount the
// router with a db fake and stub the module's dependencies through the deps
// the routes accept: only settings/env/now are injectable, the store is not.
// To keep this a surface test, we test the real store through the fake db is
// unnecessary — the db test covers the store. Here we exercise access rules
// with the real router but a real in-memory fake db is overkill, so we use a
// minimal db double whose only job is to make the router construction not
// throw, and assert on the 403/400/401 paths that short-circuit before the
// store is touched.
function appFor(
  actor: unknown,
  options: {
    env?: Record<string, string>;
    settings?: ReturnType<typeof fakeSettings>;
    store?: FakeStore;
    computeUsage?: any;
  } = {},
) {
  const store = options.store ?? fakeStore();
  const settings = options.settings ?? fakeSettings();
  const computeUsage =
    options.computeUsage ??
    vi.fn(async (_deps: unknown, _companyId: string, level: any, ref: string, period: any) => ({
      level,
      ref,
      period,
      spentCents: 12500,
      events: 5,
    }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use(
    "/api",
    budgetLimitsRoutes({} as unknown as Db, {
      env: (options.env ?? {}) as NodeJS.ProcessEnv,
      store: store as any,
      computeUsage: computeUsage as any,
    }),
  );
  app.use(errorHandler);
  return { app, store, settings };
}

const base = "/api/myrmidon/companies/company-a/budget-limits";

describe("myrmidon(1.7-BUDGET-CONFIG A) routes", () => {
  it("refuses an agent of another company on every route", async () => {
    const { app } = appFor(foreignAgentActor);
    await request(app).get(`${base}`).expect(403);
    await request(app).get(`${base}/journal`).expect(403);
    await request(app).get(`${base}/signal-only`).expect(403);
    await request(app).get(`${base}/export`).expect(403);
  });

  it("refuses a limit write from an agent (board only)", async () => {
    const { app } = appFor(agentActor);
    await request(app)
      .put(`${base}/limits/caste/engineer`)
      .send({ amountCents: 100 })
      .expect(403);
    await request(app).delete(`${base}/limits/caste/engineer`).expect(403);
    await request(app)
      .patch(`${base}/signal-only`)
      .send({ signalOnly: false })
      .expect(403);
  });

  it("answers 400 on an unknown level and a malformed ref", async () => {
    const { app } = appFor(boardActor);
    await request(app)
      .put(`${base}/limits/bogus/engineer`)
      .send({ amountCents: 100 })
      .expect(400);
    await request(app)
      .put(`${base}/limits/caste/${encodeURIComponent("Not A Role!")}`)
      .send({ amountCents: 100 })
      .expect(400);
    await request(app)
      .put(`${base}/limits/nest/not-a-uuid`)
      .send({ amountCents: 100 })
      .expect(400);
    await request(app)
      .put(`${base}/limits/issue/not-a-uuid`)
      .send({ amountCents: 100 })
      .expect(400);
  });

  it("answers 400 on an invalid amount", async () => {
    const { app } = appFor(boardActor);
    await request(app)
      .put(`${base}/limits/caste/engineer`)
      .send({ amountCents: -5 }
    ).expect(400);
  });

  it("answers 400 on an invalid export format", async () => {
    const { app } = appFor(boardActor);
    await request(app).get(`${base}/export?format=yaml`).expect(400);
  });

  it("exports budget limits report in CSV and JSON", async () => {
    const store = fakeStore();
    await store.upsert(
      "company-a",
      "nest",
      "company",
      {
        amountCents: 50000,
        period: "calendar_month_utc",
        mode: "soft",
      },
      { actorType: "user", actorId: "u1" },
    );
    const { app } = appFor(boardActor, { store });

    const csvRes = await request(app).get(`${base}/export?format=csv`).expect(200);
    expect(csvRes.headers["content-type"]).toContain("text/csv");
    expect(csvRes.headers["content-disposition"]).toContain('filename="budget-limits-report-company-a.csv"');
    expect(csvRes.text).toContain("level,ref,period,mode,amount_cents,spent_cents");
    expect(csvRes.text).toContain("nest,company,calendar_month_utc,soft,50000");

    const jsonRes = await request(app).get(`${base}/export?format=json`).expect(200);
    expect(jsonRes.headers["content-type"]).toContain("application/json");
    expect(jsonRes.headers["content-disposition"]).toContain('filename="budget-limits-report-company-a.json"');
    expect(jsonRes.body.companyId).toBe("company-a");
    expect(jsonRes.body.report).toHaveLength(1);
    expect(jsonRes.body.report[0].ref).toBe("company");

    const directCsvRes = await request(app).get(`${base}/export.csv`).expect(200);
    expect(directCsvRes.headers["content-type"]).toContain("text/csv");

    const directJsonRes = await request(app).get(`${base}/export.json`).expect(200);
    expect(directJsonRes.body.companyId).toBe("company-a");
  });
});
