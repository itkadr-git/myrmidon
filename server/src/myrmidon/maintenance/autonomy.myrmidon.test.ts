// myrmidon(1.6-AUTONOMY): test that maintenance routes respect the autonomy matrix.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { maintenanceRoutes } from "./routes.js";
import { maintenanceService, type MaintenanceServiceDeps } from "./service.js";
import { readMaintenanceSettings } from "./settings.js";
import { emptyMaintenanceDocument, type MaintenanceDocument, MAINTENANCE_SCOPE_TYPES } from "./domain.js";
import { autonomyGate, type AutonomyGateDeps } from "../autonomy/gate.js";
import { emptyAutonomyDocument } from "../autonomy/store.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

// Mock autonomy gate that forbids deploy action
function forbiddenAutonomyGate(): any {
  return {
    assertAllowed: async (req: any, actionClass: string) => {
      if (actionClass === "deploy" && req.actor?.type === "agent") {
        const error: any = new Error("This action is forbidden for this role by the autonomy matrix");
        error.status = 403;
        error.body = { error: "This action is forbidden for this role by the autonomy matrix", code: "autonomy_forbidden", actionClass: "deploy", role: "engineer" };
        throw error;
      }
      return { verdict: "allowed", role: "admin", actionClass };
    }
  };
}

// Mock autonomy gate that allows deploy action
function allowedAutonomyGate(): any {
  return {
    assertAllowed: async (req: any, actionClass: string) => {
      return { verdict: "allowed", role: "admin", actionClass };
    }
  };
}

function harness(autonomyGateMock: any = allowedAutonomyGate()) {
  const doc: MaintenanceDocument = emptyMaintenanceDocument();
  const deps: MaintenanceServiceDeps = {
    settings: readMaintenanceSettings({}),
    logActivity: (async () => ({})) as unknown as MaintenanceServiceDeps["logActivity"],
    now: () => new Date(),
  };
  const store = {
    read: async () => structuredClone(doc),
    mutate: async <T>(change: (current: MaintenanceDocument) => { next: MaintenanceDocument | null; result: T }) => {
      const { next, result } = change(doc);
      if (next) Object.assign(doc, next);
      return { doc, result, changed: next !== null };
    },
  };

  // Mock the dbAutonomyGate to return our mock
  vi.mock("../autonomy/gate.js", () => ({
    dbAutonomyGate: () => autonomyGateMock,
    AUTONOMY_FORBIDDEN_CODE: "autonomy_forbidden"
  }));

  const service = maintenanceService(store as unknown as Db, deps);
  const withActor = (actor: unknown) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", maintenanceRoutes({} as Db, service));
    app.use(errorHandler);
    return app;
  };
  return { app: withActor(member), withActor };
}

const URL = "/api/myrmidon/maintenance";

describe("maintenance routes autonomy integration", () => {
  it("POST /api/myrmidon/maintenance rejects forbidden deploy action for agent caller", async () => {
    const h = harness(forbiddenAutonomyGate());

    // Test that an agent trying to enter maintenance mode gets forbidden
    const res = await request(h.withActor(agentActor))
      .post(URL)
      .send({
        action: "enter",
        scope: { type: "instance" },
        reason: "Test maintenance"
      })
      .expect(403);

    expect(res.body.code).toBe("autonomy_forbidden");
    expect(res.body.actionClass).toBe("deploy");
  });

  it("POST /api/myrmidon/maintenance allows deploy action for admin caller", async () => {
    const h = harness(forbiddenAutonomyGate()); // Even with forbidden gate, admin should pass

    // Admins are not subject to autonomy matrix, so they should be able to enter maintenance mode
    const res = await request(h.withActor(admin))
      .post(URL)
      .send({
        action: "enter",
        scope: { type: "instance" },
        reason: "Test maintenance"
      })
      .expect(200);

    expect(res.body.state).toBeDefined();
  });
});