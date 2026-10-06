// myrmidon(1.6-AUTONOMY): test that deploy routes respect the autonomy matrix.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { deployJobsRoutes } from "./routes.js";
import { deployJobsService, type DeployJobServiceDeps } from "./service.js";
import { readDeployJobsSettings } from "./settings.js";
import { emptyDeployJobDocument, type DeployJobDocument } from "./domain.js";
import type { ProbeDeps } from "./registry.js";
import { autonomyGate, type AutonomyGateDeps, type AutonomyStore } from "../autonomy/gate.js";
import { emptyAutonomyDocument } from "../autonomy/store.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const GOOD = `sha256:${"b".repeat(64)}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CI_LABELS = {
  "org.opencontainers.image.revision": COMMIT,
  "org.opencontainers.image.source": "https://github.com/itkadr-git/myrmidon",
  "org.opencontainers.image.version": "2026.916.1-myr.1",
};

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
  const doc: DeployJobDocument = emptyDeployJobDocument();
  const deps: DeployJobServiceDeps = {
    maintenance: {
      enter: vi.fn(async () => ({ id: "window-a", state: "entering" })),
      exit: vi.fn(async () => ({ state: "off" })),
      status: vi.fn(async () => ({ instance: null })),
    },
    readHostReport: async () => null,
    readHealth: async () => null,
    settings: { ...readDeployJobsSettings({}), enabled: true, tickMs: 60_000 },
    probes: {
      registryInspectUrl: "https://registry-inspect.example.com/inspect",
      fetchJson: async (url: string) => {
        if (url.startsWith("https://registry-inspect.example.com/")) return { config: { Labels: CI_LABELS } };
        if (url.includes("/compare/")) return { status: "ahead" };
        return [];
      },
    } satisfies ProbeDeps,
    logActivity: (async () => ({})) as unknown as DeployJobServiceDeps["logActivity"],
  };
  const store = {
    read: async () => structuredClone(doc),
    mutate: async <T>(change: (current: DeployJobDocument) => { next: DeployJobDocument | null; result: T }) => {
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

  const service = deployJobsService(store as unknown as Db, deps);
  const withActor = (actor: unknown) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", deployJobsRoutes({} as Db, service));
    app.use(errorHandler);
    return app;
  };
  return { app: withActor(member), withActor };
}

const URL = "/api/myrmidon/deploy-jobs";

describe("deploy jobs routes autonomy integration", () => {
  it("POST /api/myrmidon/deploy-jobs rejects forbidden deploy action for agent caller", async () => {
    const h = harness(forbiddenAutonomyGate());

    // Test that an agent trying to create a deploy job gets forbidden
    const res = await request(h.withActor(agentActor))
      .post(URL)
      .send({ reference: GOOD, reason: "Test deployment" })
      .expect(403);

    expect(res.body.code).toBe("autonomy_forbidden");
    expect(res.body.actionClass).toBe("deploy");
  });

  it("POST /api/myrmidon/deploy-jobs allows deploy action for admin caller", async () => {
    const h = harness(forbiddenAutonomyGate()); // Even with forbidden gate, admin should pass

    // Admins are not subject to autonomy matrix, so they should be able to create deploy jobs
    const res = await request(h.withActor(admin))
      .post(URL)
      .send({ reference: GOOD, reason: "Test deployment" })
      .expect(201);

    expect(res.body.status).toBe("maintenance_entering");
    expect(res.body.digest).toBe(GOOD);
  });
});