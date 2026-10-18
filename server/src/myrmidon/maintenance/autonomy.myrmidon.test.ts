// myrmidon(1.6-AUTONOMY): autonomy gate on maintenance routes
//
// Tests that the maintenance routes properly enforce the autonomy matrix
// for deploy actions. Uses a real gate with an in-memory store.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { maintenanceRoutes } from "./routes.js";
import { AUTONOMY_FORBIDDEN_CODE } from "../autonomy/gate.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

// Mock dbAutonomyGate to return a test gate with forbidden deploy for engineers
// This must be at the top level for vi.mock hoisting
vi.mock("../autonomy/gate.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  const { memoryAutonomyStore } = await import("../autonomy/store.js");
  const { AUTONOMY_SAFE_DEFAULTS } = await import("@paperclipai/shared");

  // Create a real gate with an in-memory store that has deploy forbidden for engineers
  const store = memoryAutonomyStore({
    version: 1,
    matrix: {
      version: 2,
      rules: [
        { role: "engineer", actionClass: "deploy", verdict: "forbidden" },
      ],
      defaults: { ...AUTONOMY_SAFE_DEFAULTS },
    },
    regulations: [],
  });

  const testGate = actual.autonomyGate({
    store,
    roleOf: async (agentId: string | null) => (agentId ? "engineer" : null),
  });

  return {
    ...actual,
    dbAutonomyGate: () => testGate,
  };
});

// Create a mock service that just returns a success response
const mockService = {
  enter: async () => ({
    id: "test-window-id",
    status: "active",
    scope: { type: "instance" },
    reason: "Test maintenance",
    enteredAt: new Date().toISOString(),
  }),
  exit: async () => ({
    id: "test-window-id",
    status: "exited",
    scope: { type: "instance" },
    reason: "Test maintenance",
    enteredAt: new Date().toISOString(),
    exitedAt: new Date().toISOString(),
  }),
  status: async () => ({
    active: false,
    windows: [],
  }),
};

function harness(actor: unknown) {
  const withActor = (a: unknown) => (req: any, _res: any, next: any) => {
    req.actor = a;
    next();
  };
  const app = express();
  app.use(express.json());
  app.use("/api", withActor(actor), maintenanceRoutes({} as any, mockService as any));
  app.use(errorHandler);
  return { app };
}

describe("maintenance routes autonomy integration", () => {
  it("POST /api/myrmidon/maintenance rejects forbidden deploy action for agent caller", async () => {
    const agentActor = {
      type: "agent",
      source: "agent_key",
      agentId: "agent-123",
      companyId: COMPANY_ID,
      keyId: "key-a",
      companyIds: [COMPANY_ID],
    };

    const { app } = harness(agentActor);

    const res = await request(app)
      .post("/api/myrmidon/maintenance")
      .set("x-company-id", COMPANY_ID)
      .send({
        action: "enter",
        scope: { type: "instance" },
        reason: "Test maintenance",
      })
      .expect(403);

    expect(res.body.code).toBe(AUTONOMY_FORBIDDEN_CODE);
  });

  it("POST /api/myrmidon/maintenance allows deploy action for admin caller", async () => {
    const adminActor = {
      type: "board",
      source: "session",
      userId: "user-123",
      isInstanceAdmin: true,
      companyIds: [COMPANY_ID],
    };

    const { app } = harness(adminActor);

    await request(app)
      .post("/api/myrmidon/maintenance")
      .set("x-company-id", COMPANY_ID)
      .send({
        action: "enter",
        scope: { type: "instance" },
        reason: "Test maintenance",
      })
      .expect(200);
  });
});
