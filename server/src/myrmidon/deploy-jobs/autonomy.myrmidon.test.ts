// myrmidon(1.6-AUTONOMY): autonomy gate on deploy routes
//
// Tests that the deploy-jobs routes properly enforce the autonomy matrix
// for deploy actions. Uses a real gate with an in-memory store.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { deployJobsRoutes } from "./routes.js";
import { deployJobsService } from "./service.js";
import { AUTONOMY_FORBIDDEN_CODE } from "../autonomy/gate.js";
import { readDeployJobsSettings } from "./settings.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

// Create a proper in-memory store for deploy jobs
const mockStore = () => {
  let doc = {
    jobs: [] as any[],
    currentJobId: null as string | null,
    history: [] as any[],
  };
  return {
    read: async () => doc,
    mutate: async (change: any) => {
      const { next, result } = change(doc);
      if (next) doc = next;
      return { doc, result, changed: next !== null };
    },
  };
};

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

function harness(actor: unknown) {
  const store = mockStore();
  const svc = deployJobsService(store as any, {
    maintenance: {
      enter: async () => ({ id: "window-a", state: "entering" }),
      exit: async () => ({ state: "off" }),
      status: async () => ({ instance: { id: "window-a", state: "entering" } }),
    },
    readHostReport: async () => null,
    readHealth: async () => null,
    now: () => new Date("2026-10-06T00:00:00.000Z"),
    settings: {
      ...readDeployJobsSettings({}),
      enabled: true,
    },
    probes: {
      fetchJson: async () => {
        throw new Error("network disabled in tests");
      },
      registryInspectUrl: "https://registry-inspect.example.com/inspect",
    },
  });
  const withActor = (a: unknown) => (req: any, _res: any, next: any) => {
    req.actor = a;
    next();
  };
  const app = express();
  app.use(express.json());
  app.use("/api", withActor(actor), deployJobsRoutes(store as any, svc));
  app.use(errorHandler);
  return { app, store, svc };
}

describe("deploy-jobs routes autonomy integration", () => {
  it("POST /api/myrmidon/deploy-jobs rejects forbidden deploy action for agent caller", async () => {
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
      .post("/api/myrmidon/deploy-jobs")
      .set("x-company-id", COMPANY_ID)
      .send({
        reference: "staging",
        reason: "Test deploy",
      })
      .expect(403);

    expect(res.body.code).toBe(AUTONOMY_FORBIDDEN_CODE);
  });

  it("POST /api/myrmidon/deploy-jobs allows deploy action for admin caller", async () => {
    const adminActor = {
      type: "board",
      source: "session",
      userId: "user-123",
      isInstanceAdmin: true,
      companyIds: [COMPANY_ID],
    };

    const { app } = harness(adminActor);

    await request(app)
      .post("/api/myrmidon/deploy-jobs")
      .set("x-company-id", COMPANY_ID)
      .send({
        reference: "ghcr.io/itkadr-git/myrmidon@sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        reason: "Test deploy",
      })
      .expect(201);
  });
});
