// myrmidon(1.6-FORAGE): the FORAGING routes — access rules, the sweep switch and
// the audit rows. The store, the service and the db are fakes: this pins the
// surface, not the vendor.
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { foragingRoutes } from "./routes.js";

// myrmidon(1.6-FORAGE): the audit rows need a real database; this file pins the
// route surface with a fake one, so the writer is stubbed. Without the stub the
// two board writes answer 500 (not a route defect).
vi.mock("../../services/activity-log.js", () => ({ logActivity: vi.fn(async () => {}) }));
import type { ForagingGateSettingsService } from "./idle-gate-settings.js";
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
    skipReason: null,
    skippedRoles: [],
  })),
  budgetState: vi.fn(async () => ({ spentCents: 4, maxCostCents: 50, enabled: true })),
};

/**
 * myrmidon(1.6.2-FORAGING-IDLE-GATE): a minimal instance-settings stand-in —
 * the two methods the routes use, over one in-memory `general` row.
 */
function fakeGateSettings(general: Record<string, unknown> = {}): {
  service: ForagingGateSettingsService;
  general: Record<string, unknown>;
} {
  const state = { general: { ...general } };
  return {
    get general() {
      return state.general;
    },
    service: {
      getGeneral: vi.fn(async () => state.general),
      updateGeneral: vi.fn(async (patch: Record<string, unknown>) => {
        state.general = { ...state.general, ...patch };
        return state.general;
      }),
    } as unknown as ForagingGateSettingsService,
  };
}

// myrmidon(1.6-FORAGE): a board actor with real company access. The authz layer
// needs `companyIds` for reads and an admin flag (or an active membership) for
// writes; without them every route answers 403 and the file is red on main.
const boardActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  companyIds: ["company-a"],
  isInstanceAdmin: true,
};
const agentActor = { type: "agent", agentId: "agent-a", companyId: "company-a", source: "agent_key" };

const base = "/api/myrmidon/companies/company-a/foraging";

/** Mounts the router on an app the way the server does, with the actor the auth layer would set. */
function appFor(
  actor: unknown,
  store = fakeStore(),
  overrides: Partial<{
    enabled: boolean;
    db: Db;
    gateSettings: ForagingGateSettingsService;
    env: NodeJS.ProcessEnv;
  }> = {},
) {
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
      gateSettings: overrides.gateSettings ?? fakeGateSettings().service,
      env: overrides.env
        ?? ({ MYRMIDON_FORAGING_ENABLED: overrides.enabled === false ? "0" : "1" } as NodeJS.ProcessEnv),
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

  // myrmidon(1.6.2-FORAGING-IDLE-GATE): the switch, the source of its value and
  // the pass history the screen shows.
  it("reports the stored idle-only rule with its source and the change time", async () => {
    const stored = fakeGateSettings({
      foragingIdleGate: {
        companies: { "company-a": { idleOnly: true, updatedAt: "2026-10-04T09:00:00.000Z" } },
      },
    });
    const res = await request(appFor(boardActor, fakeStore(), { gateSettings: stored.service }))
      .get(`${base}/idle-gate`)
      .expect(200);
    expect(res.body).toMatchObject({
      idleOnly: true,
      source: "interface",
      storedIdleOnly: true,
      envOverride: null,
    });
    expect(res.body.updatedAt).toBe("2026-10-04T09:00:00.000Z");
  });

  it("shows the default when the company has no stored rule", async () => {
    const res = await request(appFor(boardActor)).get(`${base}/idle-gate`).expect(200);
    expect(res.body).toMatchObject({ idleOnly: false, source: "default", storedIdleOnly: null });
  });

  it("lets the environment force the rule over the stored value", async () => {
    const stored = fakeGateSettings({
      foragingIdleGate: { companies: { "company-a": { idleOnly: true } } },
    });
    const res = await request(
      appFor(boardActor, fakeStore(), {
        gateSettings: stored.service,
        env: { MYRMIDON_FORAGING_ENABLED: "1", MYRMIDON_FORAGING_IDLE_ONLY: "0" } as NodeJS.ProcessEnv,
      }),
    )
      .get(`${base}/idle-gate`)
      .expect(200);
    expect(res.body).toMatchObject({
      idleOnly: false,
      source: "env",
      storedIdleOnly: true,
      envOverride: false,
    });
  });

  it("stores the switch for a board actor and refuses an agent", async () => {
    const stored = fakeGateSettings();
    const app = appFor(boardActor, fakeStore(), { gateSettings: stored.service });
    const res = await request(app).put(`${base}/idle-gate`).send({ idleOnly: true }).expect(200);
    expect(res.body).toMatchObject({ idleOnly: true, source: "interface" });
    expect(stored.general.foragingIdleGate).toMatchObject({
      companies: { "company-a": { idleOnly: true } },
    });

    await request(appFor(agentActor, fakeStore(), { gateSettings: fakeGateSettings().service }))
      .put(`${base}/idle-gate`)
      .send({ idleOnly: true })
      .expect(403);
  });

  it("returns the pass history, newest first, with the skip reason", async () => {
    const stored = fakeGateSettings({
      foragingPassJournal: {
        companies: {
          "company-a": [
            {
              at: "2026-10-04T09:10:00.000Z",
              skipReason: "agents_busy_for_role",
              skippedRoles: ["engineer"],
              sourcesRead: 0,
              findings: 0,
              candidates: 0,
              spentCents: 0,
              stoppedByBudget: false,
              errors: 0,
            },
            {
              at: "2026-10-04T08:10:00.000Z",
              skipReason: null,
              skippedRoles: [],
              sourcesRead: 2,
              findings: 1,
              candidates: 1,
              spentCents: 3,
              stoppedByBudget: false,
              errors: 0,
            },
          ],
        },
      },
    });
    const res = await request(appFor(boardActor, fakeStore(), { gateSettings: stored.service }))
      .get(`${base}/passes`)
      .expect(200);
    expect(res.body.passes).toHaveLength(2);
    expect(res.body.passes[0]).toMatchObject({
      skipReason: "agents_busy_for_role",
      skippedRoles: ["engineer"],
    });
    expect(res.body.passes[1].skipReason).toBeNull();
  });
});
