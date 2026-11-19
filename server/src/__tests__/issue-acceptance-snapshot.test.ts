import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const mockSnapshotService = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock("../services/issue-acceptance-snapshot.js", () => ({
  issueAcceptanceSnapshotService: () => mockSnapshotService,
}));

const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";
// Cold import of the route module chain dominates the first test in slow
// containers (tens of seconds observed on the shared build host); keep the
// per-test ceiling above it, mirroring board-api-keys-scope-routes.test.ts.
const ROUTE_TEST_TIMEOUT_MS = 60_000;

function boardActor(companyIds: string[]) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: false,
    companyIds,
    memberships: companyIds.map((companyId) => ({
      companyId,
      status: "active",
      membershipRole: "operator",
    })),
  };
}

async function createApp(actor: unknown) {
  const routeModule = await import("../routes/issue-acceptance-snapshot.js");
  const { errorHandler: handler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", routeModule.issueAcceptanceSnapshotRoutes({} as any));
  app.use(handler);
  return app;
}

function snapshotFor(issue: { id: string; identifier: string; companyId: string }) {
  return {
    issue: { id: issue.id, identifier: issue.identifier, companyId: issue.companyId },
    document: { id: randomUUID(), latestRevisionId: randomUUID(), latestRevisionNumber: 3, body: "criteria" },
  };
}

describe("GET /api/issues/:id/acceptance-scenarios-snapshot route (OPE-15134)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the minimal atomic snapshot and nothing else", async () => {
    const issue = { id: randomUUID(), identifier: "OPE-1", companyId: companyA };
    mockSnapshotService.read.mockResolvedValue(snapshotFor(issue));

    const app = await createApp(boardActor([companyA]));
    const res = await request(app).get(`/api/issues/${issue.identifier}/acceptance-scenarios-snapshot`);

    expect(res.status, res.text).toBe(200);
    // Minimal fields only: no rich issue relations, no document metadata.
    expect(res.body).toEqual({
      issue: { id: issue.id, identifier: "OPE-1", companyId: companyA },
      document: { id: expect.any(String), latestRevisionId: expect.any(String), latestRevisionNumber: expect.any(Number), body: "criteria" },
    });
    expect(Object.keys(res.body.issue).sort()).toEqual(["companyId", "id", "identifier"]);
    expect(Object.keys(res.body.document).sort()).toEqual(["body", "id", "latestRevisionId", "latestRevisionNumber"]);
    // The whole route is one snapshot read: the authorized row is the row
    // that is served — there is no earlier, richer issue read.
    expect(mockSnapshotService.read).toHaveBeenCalledTimes(1);
    expect(mockSnapshotService.read).toHaveBeenCalledWith(issue.identifier);
  }, ROUTE_TEST_TIMEOUT_MS);

  it("carries document: null when the acceptance document is absent", async () => {
    const issue = { id: randomUUID(), identifier: "OPE-2", companyId: companyA };
    mockSnapshotService.read.mockResolvedValue({
      issue: { id: issue.id, identifier: "OPE-2", companyId: companyA },
      document: null,
    });

    const app = await createApp(boardActor([companyA]));
    const res = await request(app).get(`/api/issues/${issue.identifier}/acceptance-scenarios-snapshot`);

    expect(res.status, res.text).toBe(200);
    expect(res.body).toEqual({
      issue: { id: issue.id, identifier: "OPE-2", companyId: companyA },
      document: null,
    });
  }, ROUTE_TEST_TIMEOUT_MS);

  it("returns the identical 404 for a cross-tenant issue and an unknown issue (OPE-15145)", async () => {
    // The single snapshot row carries the tenant: when the row names a
    // company the actor cannot access (an issue that moved, or another
    // tenant's issue), the answer is the same 404 as for a missing issue —
    // the access decision is made on the row that would have been served.
    const foreign = { id: randomUUID(), identifier: "OPE-9", companyId: companyB };
    mockSnapshotService.read.mockResolvedValueOnce(snapshotFor(foreign)).mockResolvedValueOnce(null);

    const app = await createApp(boardActor([companyA]));
    const denied = await request(app).get("/api/issues/OPE-9/acceptance-scenarios-snapshot");
    const missing = await request(app).get("/api/issues/OPE-404/acceptance-scenarios-snapshot");

    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(denied.body).toEqual(missing.body);
  }, ROUTE_TEST_TIMEOUT_MS);

  it("denies agents before resource access", async () => {
    const app = await createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId: companyA,
    });
    const res = await request(app).get("/api/issues/OPE-1/acceptance-scenarios-snapshot");

    expect(res.status).toBe(403);
    expect(mockSnapshotService.read).not.toHaveBeenCalled();
  }, ROUTE_TEST_TIMEOUT_MS);

  it("denies anonymous actors with 401", async () => {
    const app = await createApp({ type: "none" });
    const res = await request(app).get("/api/issues/OPE-1/acceptance-scenarios-snapshot");
    expect(res.status).toBe(401);
    expect(mockSnapshotService.read).not.toHaveBeenCalled();
  }, ROUTE_TEST_TIMEOUT_MS);

  it("does not return a partial snapshot when the read model fails", async () => {
    const issueId = randomUUID();
    mockSnapshotService.read.mockRejectedValue(new Error("db unavailable"));

    const app = await createApp(boardActor([companyA]));
    const res = await request(app).get(`/api/issues/${issueId}/acceptance-scenarios-snapshot`);

    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(issueId);
    expect(JSON.stringify(res.body)).not.toContain("criteria");
  }, ROUTE_TEST_TIMEOUT_MS);
});
