// myrmidon(1.6-FORAGE): the FORAGING routes — access rules, the sweep switch and
// the audit rows. The store, the service and the db are fakes: this pins the
// surface, not the vendor.
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import type { ResolvedForagingSettings } from "@paperclipai/shared";
import { foragingRoutes } from "./routes.js";
import type { ForagingService } from "./service.js";
import type { ForagingFindingRow, ForagingSourceRow, ForagingStore } from "./store.js";

const source: ForagingSourceRow = {
  id: "source-1",
  companyId: "company-a",
  role: "engineer",
  url: "https://example.com/changelog",
  kind: "url",
  enabled: true,
  lastSnapshot: ["a", "b"],
  lastSnapshotAt: new Date("2026-10-02T10:00:00.000Z"),
  lastCheckedAt: new Date("2026-10-02T10:00:00.000Z"),
  lastError: null,
};

const finding: ForagingFindingRow = {
  id: "finding-1",
  sourceId: "source-1",
  role: "engineer",
  status: "unverified",
  summary: "foraged-engineer: 1 added",
  diff: { added: ["c"], removed: [] },
  skillKey: "foraged-engineer",
  candidateRef: null,
  reason: null,
  detectedAt: new Date("2026-10-02T10:00:00.000Z"),
};

function fakeStore(): ForagingStore {
  return {
    listSources: vi.fn(async () => [source]),
    enabledSources: vi.fn(async () => [source]),
    upsertSource: vi.fn(async () => source),
    deleteSource: vi.fn(async () => true),
    saveSnapshot: vi.fn(async () => {}),
    saveRead: vi.fn(async () => {}),
    insertFinding: vi.fn(async () => finding),
    listFindings: vi.fn(async () => [finding]),
    listUnverifiedFindings: vi.fn(async () => [finding]),
    markFindingCandidate: vi.fn(async () => {}),
    monthFindingCount: vi.fn(async () => 3),
    listCompanyIds: vi.fn(async () => ["company-a"]),
    insertSpendEvent: vi.fn(async () => {}),
    spendWindows: vi.fn(async () => ({
      dayCents: 0,
      monthCents: 0,
      byRole: new Map<string, number>(),
      byAgent: new Map<string, number>(),
    })),
    spendBreakdown: vi.fn(async () => [
      { role: "engineer", url: "https://example.com/changelog", costCents: 2, reads: 1, lastOccurredAt: null },
    ]),
  };
}

const service: ForagingService = {
  runPass: vi.fn(async () => ({
    sourcesRead: 1,
    findings: 1,
    candidates: 0,
    spentCents: 2,
    stoppedByBudget: false,
    errors: 0,
  })),
  budgetState: vi.fn(async () => ({
    spentCents: 4,
    dayCents: 4,
    monthCents: 4,
    maxCostCents: 50,
    enabled: true,
    dailyBudgetCents: null,
    monthlyBudgetCents: null,
  })),
};

const boardActor = { type: "board", userId: "user-1", source: "session" };
const agentActor = { type: "agent", agentId: "agent-a", companyId: "company-a", source: "agent_key" };

const base = "/api/myrmidon/companies/company-a/foraging";

/** Mounts the router on an app the way the server does, with the actor the auth layer would set. */
function appFor(actor: unknown, store = fakeStore(), overrides: Partial<{ enabled: boolean; db: Db }> = {}) {
  const db = (overrides.db ?? {}) as Db;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use(
    "/api",
    foragingRoutes({
      db,
      store,
      service,
      env: { MYRMIDON_FORAGING_ENABLED: overrides.enabled === false ? "0" : "1" } as NodeJS.ProcessEnv,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("myrmidon(1.6-FORAGE) routes", () => {
  it("lists sources with the snapshot line count for a company member", async () => {
    const res = await request(appFor(boardActor)).get(`${base}/sources`).expect(200);
    expect(res.body).toMatchObject({ enabled: true, sources: [{ id: "source-1", snapshotLines: 2 }] });
  });

  it("refuses an agent of another company", async () => {
    const res = await request(appFor({ ...agentActor, companyId: "company-b" })).get(`${base}/sources`).expect(403);
    expect(JSON.stringify(res.body)).toMatch(/another company/i);
  });

  it("refuses a source write from an agent", async () => {
    const res = await request(appFor(agentActor))
      .put(`${base}/sources`)
      .send({ role: "engineer", url: "https://example.com/a", kind: "url" })
      .expect(403);
    expect(JSON.stringify(res.body)).toMatch(/Board access required/i);
  });

  it("answers 404 on removing a source that is not there", async () => {
    const store = fakeStore();
    store.deleteSource = vi.fn(async () => false);
    await request(appFor(boardActor, store)).delete(`${base}/sources/missing`).expect(404);
  });

  it("returns the findings and the budget", async () => {
    const app = appFor(boardActor);
    const findings = await request(app).get(`${base}/findings`).expect(200);
    expect(findings.body).toMatchObject({ findings: [{ id: "finding-1", skillKey: "foraged-engineer" }] });

    const budget = await request(app).get(`${base}/budget`).expect(200);
    expect(budget.body).toMatchObject({ enabled: true, spentCents: 4, budget: { maxCostCents: 50 } });
  });

  it("runs a pass for a board actor and answers the counters", async () => {
    const res = await request(appFor(boardActor)).post(`${base}/sweep`).expect(200);
    expect(res.body).toMatchObject({ sourcesRead: 1, findings: 1, stoppedByBudget: false });
  });

  it("answers 503 on a manual pass while the sweep is switched off", async () => {
    const res = await request(appFor(boardActor, fakeStore(), { enabled: false })).post(`${base}/sweep`).expect(503);
    expect(res.body).toMatchObject({ enabled: false });
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) settings routes", () => {
  const settingsService = {
    read: vi.fn(async (): Promise<ResolvedForagingSettings> => ({
      settings: {
        enabled: true,
        intervalSec: 3600,
        minHostIntervalSec: 60,
        passBudgetCents: 50,
        dailyBudgetCents: 100,
        monthlyBudgetCents: null,
        roleBudgetCents: null,
        agentBudgetCents: null,
        enforcement: "hard",
        autoOffCostPerTaskCents: null,
      },
      sources: {
        enabled: "settings",
        intervalSec: "default",
        minHostIntervalSec: "default",
        passBudgetCents: "settings",
        dailyBudgetCents: "settings",
        monthlyBudgetCents: "default",
        roleBudgetCents: "default",
        agentBudgetCents: "default",
        enforcement: "default",
        autoOffCostPerTaskCents: "default",
      },
    })),
    update: vi.fn(async () => ({}) as ResolvedForagingSettings),
  };

  function settingsApp(actor: unknown) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use(
      "/api",
      foragingRoutes({ db: {} as Db, store: fakeStore(), service, settingsService, env: {} }),
    );
    app.use(errorHandler);
    return app;
  }

  it("reads the settings for a board actor", async () => {
    const orgBoardActor = { type: "board", userId: "user-1", source: "session", companyIds: ["company-a"] };
    const res = await request(settingsApp(orgBoardActor)).get("/api/myrmidon/foraging-settings").expect(200);
    expect(res.body.settings).toMatchObject({ enabled: true, dailyBudgetCents: 100 });
    expect(res.body.sources).toMatchObject({ enabled: "settings" });
  });

  it("refuses a read from a plain company agent", async () => {
    const res = await request(settingsApp(agentActor)).get("/api/myrmidon/foraging-settings").expect(403);
    expect(JSON.stringify(res.body)).toMatch(/Board/i);
  });

  it("saves a patch for an instance admin", async () => {
    const adminActor = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: true };
    const res = await request(settingsApp(adminActor))
      .patch("/api/myrmidon/foraging-settings")
      .send({ dailyBudgetCents: 150 })
      .expect(200);
    expect(settingsService.update).toHaveBeenCalledWith(
      expect.objectContaining({ dailyBudgetCents: 150 }),
      expect.objectContaining({ actorType: "user" }),
    );
  });

  it("refuses a write from a non-admin board member", async () => {
    const res = await request(settingsApp(boardActor))
      .patch("/api/myrmidon/foraging-settings")
      .send({ dailyBudgetCents: 150 })
      .expect(403);
    expect(JSON.stringify(res.body)).toMatch(/admin/i);
  });
});

describe("myrmidon(1.6.1-FORAGING-LIMITS-UI) spend route", () => {
  it("answers the breakdown for a company member", async () => {
    const res = await request(appFor(agentActor)).get(`${base}/spend`).expect(200);
    expect(res.body).toMatchObject({
      days: 30,
      totalCents: 2,
      rows: [{ role: "engineer", url: "https://example.com/changelog", costCents: 2 }],
    });
  });

  it("clamps the days window to 90", async () => {
    const orgBoardActor = { type: "board", userId: "user-1", source: "session", companyIds: ["company-a"] };
    const res = await request(appFor(orgBoardActor)).get(`${base}/spend?days=365`).expect(200);
    expect(res.body.days).toBe(90);
  });

  it("refuses an agent of another company", async () => {
    await request(appFor({ ...agentActor, companyId: "company-b" })).get(`${base}/spend`).expect(403);
  });
});
