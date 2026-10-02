// myrmidon(TRACING-HEALTH): route tests — auth contract and the
// request/response shape of the "LLM tracing" health endpoint.
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { tracingHealthRoutes } from "./routes.js";
import { tracingHealthService, type TracingHealthCard } from "./service.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";

const board = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: true,
  companyIds: [COMPANY],
};
const foreignBoard = { ...board, userId: "user-b", companyIds: [OTHER] };
const agentActor = { type: "agent", source: "agent_key", agentId: "agent-b", companyId: COMPANY, keyId: "k" };
const anonymous = { type: "none" };

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function makeDb() {
  const proxy: Record<string, unknown> = {
    from: () => proxy,
    where: () => proxy,
    then: (resolve: (rows: unknown) => void) => Promise.resolve([{ count: 0 }]).then(resolve),
  };
  return { select: () => proxy } as unknown as Parameters<typeof tracingHealthService>[0]["db"];
}

const OK_CARD: TracingHealthCard = {
  status: "ok",
  checks: {
    gatewayTraffic: { ok: true, note: "3 gateway requests in the window" },
    eventsCore: { ok: true, note: "5 event(s) in events_core over 15 min", count: 5 },
    callbackErrors: { ok: true, note: "no callback logging failures", failures: 0 },
  },
  summary: "LLM tracing is healthy",
  enabled: true,
  windowMs: 900_000,
  checkedAt: "2026-10-02T12:00:00.000Z",
};

function app(actor: unknown, card: TracingHealthCard = OK_CARD) {
  const server = express();
  server.use(express.json());
  server.use((_req, _res, next) => {
    (_req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    tracingHealthRoutes(makeDb(), {
      assertBoard(req) {
        if (req.actor?.type !== "board") throw httpError(403, "Board access required");
      },
      assertCompanyAccess(req, companyId) {
        const a = req.actor as { type?: string; source?: string; companyId?: string; companyIds?: string[] } | undefined;
        if (!a || a.type === "none") throw httpError(401, "Authentication required");
        if (a.type === "agent" && a.companyId !== companyId) throw httpError(403, "Agent key cannot access another company");
        if (a.type === "board" && a.source !== "local_implicit" && !(a.companyIds ?? []).includes(companyId)) {
          throw httpError(403, "Company membership required");
        }
      },
      service() {
        return {
          settings: () => ({ enabled: true }),
          async evaluate() {
            return card;
          },
          countGatewayRequests: async () => 0,
        } as unknown as ReturnType<typeof tracingHealthService>;
      },
    }),
  );
  server.use((err: unknown, _req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }, _next: unknown) => {
    const status = (err as { status?: number } | null)?.status;
    res.status(typeof status === "number" ? status : 500).json({ error: err instanceof Error ? err.message : "error" });
  });
  return server;
}

describe("myrmidon(TRACING-HEALTH) routes", () => {
  it("serves the card to a board actor of the company", async () => {
    const response = await request(app(board)).get(`/api/myrmidon/companies/${COMPANY}/tracing/health`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", enabled: true });
    expect(response.body.checks.eventsCore.count).toBe(5);
  });

  it("refuses an agent actor (operator territory)", async () => {
    const response = await request(app(agentActor)).get(`/api/myrmidon/companies/${COMPANY}/tracing/health`);
    expect(response.status).toBe(403);
  });

  it("refuses an anonymous caller", async () => {
    const response = await request(app(anonymous)).get(`/api/myrmidon/companies/${COMPANY}/tracing/health`);
    expect(response.status).toBe(403);
  });

  it("refuses a board actor of another company", async () => {
    const response = await request(app(foreignBoard)).get(`/api/myrmidon/companies/${COMPANY}/tracing/health`);
    expect(response.status).toBe(403);
  });

  it("answers the not-enabled card shape (200, enabled: false) when the instance switch is off", async () => {
    const notEnabled: TracingHealthCard = {
      ...OK_CARD,
      status: "ok",
      enabled: false,
      summary: "LLM tracing health is not enabled",
      checks: {
        gatewayTraffic: { ok: true, note: "not evaluated" },
        eventsCore: { ok: true, note: "not evaluated", count: null },
        callbackErrors: { ok: true, note: "not evaluated", failures: null },
      },
    };
    const response = await request(app(board, notEnabled)).get(`/api/myrmidon/companies/${COMPANY}/tracing/health`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ enabled: false, status: "ok" });
  });
});
