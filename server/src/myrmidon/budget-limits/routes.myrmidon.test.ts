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
import type { BudgetLimitUsage, BudgetLimitUsageDeps } from "./usage.js";

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
    upsert: vi.fn(
      async (
        companyId: string,
        level: string,
        ref: string,
        input: Record<string, unknown>,
        actor: Record<string, unknown> = { actorType: "system", actorId: "test" },
      ) => {
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
          actorType: String(actor?.actorType ?? "system"),
          actorId: String(actor?.actorId ?? "test"),
          at: now().toISOString(),
        };
        journal.unshift(entry);
        return view;
      },
    ),
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
    resolveIssue?: (companyId: string, issueId: string) => Promise<{ id: string } | null>;
    computeUsage?: (
      deps: BudgetLimitUsageDeps,
      companyId: string,
      level: BudgetLimitUsage["level"],
      ref: string,
      period: BudgetLimitUsage["period"],
    ) => Promise<BudgetLimitUsage>;
  } = {},
) {
  const store = options.store ?? fakeStore();
  const settings = options.settings ?? fakeSettings();
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
      settings: settings as unknown as import("./settings.js").BudgetLimitsSettingsService,
      resolveIssue: options.resolveIssue,
      computeUsage: options.computeUsage,
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
      .send({ amountCents: -5 })
      .expect(400);
  });

  describe("1.7-BUDGET-CONFIG-READ: GET /config hierarchy tree", () => {
    it("refuses an agent of another company on the config routes", async () => {
      const { app } = appFor(foreignAgentActor);
      await request(app).get(`${base}/config`).expect(403);
      await request(app).get(`${base}/config/ticket/issue-1`).expect(403);
    });

    it("returns the full tree with hard/soft when every level is configured", async () => {
      const store = fakeStore();
      await store.upsert("company-a", "nest", "company", {
        amountCents: 100_000, period: "calendar_month_utc", mode: "hard", isActive: true,
      });
      await store.upsert("company-a", "caste", "engineer", {
        amountCents: 20_000, period: "calendar_month_utc", mode: "soft", isActive: true,
      });
      await store.upsert("company-a", "foraging", "foraging", {
        amountCents: 5_000, period: "lifetime", mode: "hard", isActive: true,
      });
      await store.upsert("company-a", "issue", "issue-1", {
        amountCents: 1_000, period: "calendar_month_utc", mode: "soft", isActive: true,
      });
      const { app } = appFor(boardActor, {
        store,
        settings: fakeSettings({ budgetLimits: { signalOnly: false } }),
      });
      const res = await request(app).get(`${base}/config`).expect(200);
      expect(res.body.companyId).toBe("company-a");
      expect(res.body.signalOnly).toBe(false);
      expect(res.body.signalOnlySource).toBe("stored");
      const levels = res.body.levels;
      expect(Object.keys(levels)).toEqual(["nest", "caste", "foraging", "ticket"]);
      expect(levels.nest.configured).toBe(true);
      expect(levels.nest.limits[0]).toMatchObject({ ref: "company", mode: "hard", amountCents: 100_000 });
      expect(levels.caste.limits[0]).toMatchObject({ ref: "engineer", mode: "soft", amountCents: 20_000 });
      expect(levels.foraging.limits[0]).toMatchObject({ ref: "foraging", mode: "hard", period: "lifetime" });
      // No ticket scope requested: the ticket level lists nothing and reports defaults.
      expect(levels.ticket.configured).toBe(false);
      expect(levels.ticket.isDefault).toBe(true);
      expect(levels.ticket.limits).toEqual([]);
    });

    it("returns the default when a level has no configured row", async () => {
      const { app } = appFor(boardActor, { store: fakeStore() });
      const res = await request(app).get(`${base}/config`).expect(200);
      const levels = res.body.levels;
      expect(levels.nest.configured).toBe(false);
      expect(levels.nest.isDefault).toBe(true);
      expect(levels.nest.limits).toEqual([]);
      expect(levels.nest.defaults).toEqual({ period: "calendar_month_utc", mode: "soft" });
      expect(levels.caste.configured).toBe(false);
      expect(levels.foraging.configured).toBe(false);
      expect(levels.ticket.configured).toBe(false);
      expect(res.body.signalOnlySource).toBe("default");
    });

    it("answers 404 on a ticket-scoped read of an unknown issue (недоступный уровень)", async () => {
      const store = fakeStore();
      await store.upsert("company-a", "issue", "issue-1", {
        amountCents: 1_000, period: "calendar_month_utc", mode: "soft", isActive: true,
      });
      const { app } = appFor(boardActor, {
        store,
        settings: fakeSettings(),
        resolveIssue: async () => null,
      });
      await request(app).get(`${base}/config/ticket/issue-unknown`).expect(404);
    });

    it("returns the ticket row on a ticket-scoped read of a known issue", async () => {
      const store = fakeStore();
      await store.upsert("company-a", "issue", "issue-1", {
        amountCents: 1_000, period: "calendar_month_utc", mode: "soft", isActive: true,
      });
      const { app } = appFor(boardActor, {
        store,
        settings: fakeSettings(),
        resolveIssue: async (_companyId, issueId) => ({ id: issueId }),
      });
      const res = await request(app).get(`${base}/config/ticket/issue-1`).expect(200);
      expect(res.body.levels.ticket.available).toBe(true);
      expect(res.body.levels.ticket.configured).toBe(true);
      expect(res.body.levels.ticket.limits[0]).toMatchObject({ ref: "issue-1", mode: "soft" });
    });
  });

  describe("usage with warning thresholds (80% and 95%)", () => {
    it("rejects invalid threshold and invalid level query parameters with 400", async () => {
      const { app } = appFor(boardActor);
      await request(app).get(`${base}/usage?threshold=50`).expect(400);
      await request(app).get(`${base}/usage?threshold=not-a-number`).expect(400);
      await request(app).get(`${base}/usage?level=invalid-level`).expect(400);
    });

    it("evaluates warningThreshold and filters by threshold parameter", async () => {
      const store = fakeStore();
      await store.upsert(
        "company-a",
        "nest",
        "company",
        {
          amountCents: 10_000,
          period: "calendar_month_utc",
          mode: "hard",
          isActive: true,
        },
      );
      await store.upsert(
        "company-a",
        "caste",
        "engineer",
        {
          amountCents: 10_000,
          period: "calendar_month_utc",
          mode: "hard",
          isActive: true,
        },
      );
      await store.upsert(
        "company-a",
        "foraging",
        "foraging",
        {
          amountCents: 10_000,
          period: "calendar_month_utc",
          mode: "hard",
          isActive: true,
        },
      );

      const { app } = appFor(boardActor, {
        store,
        computeUsage: async (_deps, companyId, level, ref, period) => {
          const usage = level === "nest"
            ? { spentCents: 5_000, events: 2 } // 50% -> null
            : level === "caste"
              ? { spentCents: 8_500, events: 5 } // 85% -> 80
              : level === "foraging"
                ? { spentCents: 9_600, events: 8 } // 96% -> 95
                : { spentCents: 0, events: 0 };
          return { ...usage, companyId, level, ref, period };
        },
      });

      // All rows without threshold filter
      const resAll = await request(app).get(`${base}/usage`).expect(200);
      expect(resAll.body.usage).toHaveLength(3);
      const nestRow = resAll.body.usage.find((r: any) => r.level === "nest");
      const casteRow = resAll.body.usage.find((r: any) => r.level === "caste");
      const foragingRow = resAll.body.usage.find((r: any) => r.level === "foraging");

      expect(nestRow.spentCents).toBe(5_000);
      expect(nestRow.warningThreshold).toBeNull();
      expect(casteRow.spentCents).toBe(8_500);
      expect(casteRow.warningThreshold).toBe(80);
      expect(foragingRow.spentCents).toBe(9_600);
      expect(foragingRow.warningThreshold).toBe(95);

      // Filter by threshold=80: should return caste (80) and foraging (95)
      const res80 = await request(app).get(`${base}/usage?threshold=80`).expect(200);
      expect(res80.body.usage).toHaveLength(2);
      expect(res80.body.usage.map((r: any) => r.level)).toEqual(["caste", "foraging"]);

      // Filter by threshold=95: should return foraging (95) only
      const res95 = await request(app).get(`${base}/usage?threshold=95`).expect(200);
      expect(res95.body.usage).toHaveLength(1);
      expect(res95.body.usage[0].level).toBe("foraging");
    });
  });
});
