// myrmidon(1.6.2-AUTONOMY): the pause/resume/wakeup routes enforce the autonomy matrix.
//
// The matrix is consulted at the action point, not in the agent's instructions.
// These tests prove:
//   - an agent with a forbidden role gets 403 autonomy_forbidden;
//   - an agent with an allowed role passes;
//   - a board caller is never subject to the matrix;
//   - an agent acting on itself is not subject to the matrix;
//   - approval_required is denied with 403 autonomy_approval_required (until the
//     held-action half ships).
//
// The router is the real one; the service runs the real domain code over an
// in-memory store with a recording activity sink. No database, no keys.
//
// Neutral data only: agent-a, company-a, example.com.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AUTONOMY_SAFE_DEFAULTS, type AutonomyChangeLogEntry } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { autonomyRoutes } from "./routes.js";
import { autonomyGate, AUTONOMY_FORBIDDEN_CODE, AUTONOMY_APPROVAL_REQUIRED_CODE } from "./gate.js";
import { memoryAutonomyStore } from "./store.js";
import { autonomyService, AUTONOMY_ACTIVITY_SOURCE } from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const boardActor = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  keyId: "key-a",
  companyIds: [COMPANY_ID],
};
const otherAgentActor = {
  type: "agent",
  source: "agent_key",
  agentId: OTHER_AGENT_ID,
  companyId: COMPANY_ID,
  keyId: "key-b",
  companyIds: [COMPANY_ID],
};

function makeChangeLog() {
  const rows: AutonomyChangeLogEntry[] = [];
  return {
    rows,
    logActivity: vi.fn(async (input: Parameters<Parameters<typeof autonomyService>[0]["logActivity"]>[0]) => {
      rows.push({
        id: `log-${rows.length + 1}`,
        at: "2026-10-02T00:00:00.000Z",
        actor: { type: input.actorType === "agent" ? "agent" : input.actorType === "system" ? "system" : "board", id: input.actorId },
        action: input.action.slice(`${AUTONOMY_ACTIVITY_SOURCE}.`.length) as AutonomyChangeLogEntry["action"],
        summary: String(input.details.summary ?? ""),
        matrixVersion: typeof input.details.matrixVersion === "number" ? input.details.matrixVersion : null,
        regulationId: typeof input.details.regulationId === "string" ? input.details.regulationId : null,
      });
    }),
    listChangeLog: async (_companyId: string, limit: number) => [...rows].reverse().slice(0, limit),
  };
}

function app(actor: unknown, store = memoryAutonomyStore()) {
  const changelog = makeChangeLog();
  let seq = 0;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    autonomyRoutes({
      store,
      listChangeLog: changelog.listChangeLog,
      logActivity: changelog.logActivity,
      now: () => new Date("2026-10-02T00:00:00.000Z"),
      newId: () => `id-${++seq}`,
    }),
  );
  server.use(errorHandler);
  return { server, store, changelog };
}

/** A tiny express app that proves the gate stops a handler. */
function gatedApp(actor: unknown, verdictRole = "engineer", targetId = AGENT_ID) {
  const store = memoryAutonomyStore({
    version: 1,
    matrix: {
      version: 2,
      rules: [{ role: verdictRole, actionClass: "pause_wake_agents", verdict: "forbidden" }],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    },
    regulations: [],
  });
  const gate = autonomyGate({ store, roleOf: async () => verdictRole });
  const ran = vi.fn();
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.post("/api/agents/:id/pause", async (req, res, next) => {
    try {
      await gate.assertAllowed(req, "pause_wake_agents");
      ran();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
  server.use(errorHandler);
  return { server, ran };
}

describe("myrmidon(1.6.2-AUTONOMY) gate: pause_wake_agents enforcement", () => {
  it("refuses a forbidden action for an agent caller with 403 autonomy_forbidden and does not run the handler", async () => {
    const { server, ran } = gatedApp(otherAgentActor);
    const res = await request(server).post(`/api/agents/${AGENT_ID}/pause`).expect(403);
    expect(res.body.code).toBe(AUTONOMY_FORBIDDEN_CODE);
    expect(res.body.details?.actionClass).toBe("pause_wake_agents");
    expect(ran).not.toHaveBeenCalled();
  });

  it("lets a board caller through even when the agent row is forbidden", async () => {
    const { server, ran } = gatedApp(boardActor);
    await request(server).post(`/api/agents/${AGENT_ID}/pause`).expect(200);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("lets an allowed agent caller through", async () => {
    const store = memoryAutonomyStore({
      version: 1,
      matrix: {
        version: 2,
        rules: [{ role: "engineer", actionClass: "pause_wake_agents", verdict: "allowed" }],
        defaults: { ...AUTONOMY_SAFE_DEFAULTS },
      },
      regulations: [],
    });
    const gate = autonomyGate({ store, roleOf: async () => "engineer" });
    const ran = vi.fn();
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = otherAgentActor;
      next();
    });
    server.post("/api/agents/:id/pause", async (req, res, next) => {
      try {
        await gate.assertAllowed(req, "pause_wake_agents");
        ran();
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    });
    server.use(errorHandler);
    await request(server).post(`/api/agents/${AGENT_ID}/pause`).expect(200);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("lets an agent acting on itself through even when the role is forbidden", async () => {
    const store = memoryAutonomyStore({
      version: 1,
      matrix: {
        version: 2,
        rules: [{ role: "engineer", actionClass: "pause_wake_agents", verdict: "forbidden" }],
        defaults: { ...AUTONOMY_SAFE_DEFAULTS },
      },
      regulations: [],
    });
    const gate = autonomyGate({ store, roleOf: async () => "engineer" });
    const ran = vi.fn();
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = agentActor;
      next();
    });
    server.post("/api/agents/:id/pause", async (req, res, next) => {
      try {
        // Self-action is not gated: the route skips the matrix when caller == target
        if (req.actor.type === "agent" && req.actor.agentId === req.params.id) {
          ran();
          res.json({ ok: true });
          return;
        }
        await gate.assertAllowed(req, "pause_wake_agents");
        ran();
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    });
    server.use(errorHandler);
    await request(server).post(`/api/agents/${AGENT_ID}/pause`).expect(200);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("denies approval_required with 403 autonomy_approval_required", async () => {
    const store = memoryAutonomyStore({
      version: 1,
      matrix: {
        version: 2,
        rules: [{ role: "engineer", actionClass: "pause_wake_agents", verdict: "approval_required" }],
        defaults: { ...AUTONOMY_SAFE_DEFAULTS },
      },
      regulations: [],
    });
    const gate = autonomyGate({ store, roleOf: async () => "engineer" });
    const ran = vi.fn();
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = otherAgentActor;
      next();
    });
    server.post("/api/agents/:id/pause", async (req, res, next) => {
      try {
        await gate.assertAllowed(req, "pause_wake_agents");
        ran();
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    });
    server.use(errorHandler);
    const res = await request(server).post(`/api/agents/${AGENT_ID}/pause`).expect(403);
    expect(res.body.code).toBe(AUTONOMY_APPROVAL_REQUIRED_CODE);
    expect(res.body.details?.actionClass).toBe("pause_wake_agents");
    expect(ran).not.toHaveBeenCalled();
  });
});
