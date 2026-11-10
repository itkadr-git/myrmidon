// myrmidon(1.6.8 TOKENS-TRACE authz / OPE-12675): the trace-export routes must
// reject every caller that is not a board actor with access to the company in
// the path — before any query parsing and before the store reads the database.
// Store functions are mocked so the suites assert the call counts, not rows.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { errorHandler } from "../middleware/index.js";
import { buildTokensTraceRoutes } from "../myrmidon/tokens-trace/routes.js";

const mocks = vi.hoisted(() => ({
  aggregateByAgent: vi.fn(async () => [
    { agentId: "11111111-1111-4111-8111-111111111111", calls: 1, promptTokens: 10 },
  ]),
  reconcileWithSpendLogs: vi.fn(async () => ({
    traces: [{ agentId: "a1", calls: 1, promptTokens: 10, cachedPromptTokens: 0, completionTokens: 5, costMicroUsd: 0 }],
    spendLogs: [],
    comparison: [],
  })),
}));

vi.mock("../myrmidon/tokens-trace/store.js", () => ({
  aggregateByAgent: mocks.aggregateByAgent,
  reconcileWithSpendLogs: mocks.reconcileWithSpendLogs,
  // reconcilePerCall is reached only with detail=calls; the suites below never
  // get past authz, so a throwing stub also proves the guard order.
  reconcilePerCall: vi.fn(async () => {
    throw new Error("reconcilePerCall must not be called before authz passes");
  }),
  findPerCallMismatches: vi.fn(() => []),
  persistLlmCallTraces: vi.fn(),
  inferFromRunUsage: vi.fn(),
}));

type Actor = Express.Request["actor"];

const boardMemberOfCompanyA: Actor = {
  type: "board",
  userId: "board-user",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-a"],
} as unknown as Actor;

const boardMemberElsewhere: Actor = {
  type: "board",
  userId: "board-user-2",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-b"],
} as unknown as Actor;

const agentOfCompanyA: Actor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-a",
  source: "agent_key",
} as unknown as Actor;

const anonymous: Actor = { type: "none", source: "none" } as unknown as Actor;

function appFor(actor: Actor): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(buildTokensTraceRoutes({ db: {} as Db }));
  app.use(errorHandler);
  return app;
}

const AGENTS_URL = "/myrmidon/companies/company-a/tokens-trace/agents?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z";
const RECONCILE_URL = "/myrmidon/companies/company-a/tokens-trace/reconcile?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z";

function expectNoStoreReads() {
  expect(mocks.aggregateByAgent).not.toHaveBeenCalled();
  expect(mocks.reconcileWithSpendLogs).not.toHaveBeenCalled();
}

beforeEach(() => {
  mocks.aggregateByAgent.mockClear();
  mocks.reconcileWithSpendLogs.mockClear();
});

describe("tokens-trace authz (OPE-12675)", () => {
  describe("GET /agents", () => {
    it("answers 401 to an anonymous caller without reading the store", async () => {
      const res = await request(appFor(anonymous)).get(AGENTS_URL);
      expect(res.status).toBe(401);
      expectNoStoreReads();
    });

    it("answers 403 to an agent key without reading the store", async () => {
      const res = await request(appFor(agentOfCompanyA)).get(AGENTS_URL);
      expect(res.status).toBe(403);
      expectNoStoreReads();
    });

    it("answers 403 to a board user without access to the path company", async () => {
      const res = await request(appFor(boardMemberElsewhere)).get(AGENTS_URL);
      expect(res.status).toBe(403);
      expectNoStoreReads();
    });

    it("answers 200 with the store payload to an allowed board user", async () => {
      const res = await request(appFor(boardMemberOfCompanyA)).get(AGENTS_URL);
      expect(res.status).toBe(200);
      expect(mocks.aggregateByAgent).toHaveBeenCalledTimes(1);
      expect(mocks.aggregateByAgent.mock.calls[0]?.[0]).toMatchObject({ companyId: "company-a" });
      expect(res.body).toMatchObject({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-02T00:00:00.000Z",
        },
      });
      expect(res.body.agents).toHaveLength(1);
    });

    it("still validates the window after authz (400 on a bad window)", async () => {
      const res = await request(appFor(boardMemberOfCompanyA)).get(
        "/myrmidon/companies/company-a/tokens-trace/agents?from=not-a-date&to=2026-01-02T00:00:00Z",
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_window" });
      expectNoStoreReads();
    });
  });

  describe("GET /reconcile", () => {
    it("answers 401 to an anonymous caller without reading the store", async () => {
      const res = await request(appFor(anonymous)).get(RECONCILE_URL);
      expect(res.status).toBe(401);
      expectNoStoreReads();
    });

    it("answers 403 to an agent key without reading the store", async () => {
      const res = await request(appFor(agentOfCompanyA)).get(RECONCILE_URL);
      expect(res.status).toBe(403);
      expectNoStoreReads();
    });

    it("answers 403 to a board user without access to the path company", async () => {
      const res = await request(appFor(boardMemberElsewhere)).get(RECONCILE_URL);
      expect(res.status).toBe(403);
      expectNoStoreReads();
    });

    it("answers 200 with the store payload to an allowed board user", async () => {
      const res = await request(appFor(boardMemberOfCompanyA)).get(RECONCILE_URL);
      expect(res.status).toBe(200);
      expect(mocks.reconcileWithSpendLogs).toHaveBeenCalledTimes(1);
      expect(mocks.reconcileWithSpendLogs.mock.calls[0]?.[0]).toMatchObject({ companyId: "company-a" });
      expect(res.body).toMatchObject({
        window: {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-02T00:00:00.000Z",
        },
        traces: expect.any(Array),
        spendLogs: expect.any(Array),
        comparison: expect.any(Array),
      });
    });

    it("still validates the window after authz (400 on a bad window)", async () => {
      const res = await request(appFor(boardMemberOfCompanyA)).get(
        "/myrmidon/companies/company-a/tokens-trace/reconcile?from=2026-01-01T00:00:00Z&to=nope",
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_window" });
      expectNoStoreReads();
    });
  });
});
