// myrmidon(CONTAINER-SCOPE): the routes — access rules, the shape of the answer
// and the audit rows. The service and the db are fakes: this pins the surface,
// not the vendor.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { containerScopeRoutes } from "./routes.js";
import type { ContainerScopeService } from "./service.js";
import type { ContainerScopeOverview } from "./domain.js";

const logActivity = vi.fn(async () => ({ id: "activity-1" }));
vi.mock("../../services/activity-log.js", () => ({
  logActivity: (...args: unknown[]) => logActivity(...(args as [])),
}));

const COMPANY = "company-a";
const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const GROUP_DEV = "55555555-5555-4555-8555-555555555555";

const overview: ContainerScopeOverview = {
  instances: [
    { kind: "group", ref: GROUP_DEV, mode: "per-scope", diskMode: "isolated", label: "Developers", agentCount: 2 },
  ],
  containers: [
    {
      containerKey: `scope:group-${GROUP_DEV}`,
      shared: true,
      scope: { kind: "group", ref: GROUP_DEV, label: "Developers" },
      members: [
        { agentId: AGENT_A, name: "dev-1" },
        { agentId: AGENT_B, name: "dev-2" },
      ],
      limits: { memoryMb: 4096, cpus: 2 },
      restartRequired: [AGENT_A],
    },
  ],
  agents: [
    {
      agentId: AGENT_A,
      name: "dev-1",
      role: "engineer",
      containerKey: `scope:group-${GROUP_DEV}`,
      shared: true,
      scope: { kind: "group", ref: GROUP_DEV, label: "Developers" },
      source: "group",
      reason: "instance-per-scope",
      problems: [],
      appliedContainerKey: null,
      restartRequired: true,
      restartReason: "container-scope-applied",
      enrolled: true,
    },
  ],
  enrolments: [{ containerKey: `scope:group-${GROUP_DEV}`, shared: true, roster: [AGENT_A, AGENT_B] }],
  limits: { memoryMb: 4096, cpus: 2 },
  sharedAgentCount: 2,
};

function fakeService(overrides: Partial<ContainerScopeService> = {}): ContainerScopeService {
  return {
    overview: vi.fn(async () => overview),
    setInstance: vi.fn(async () => ({
      instance: overview.instances[0],
      restartRequired: [AGENT_A, AGENT_B],
    })),
    removeInstance: vi.fn(async () => true),
    recompute: vi.fn(async () => ({ agents: 3, restartRequired: [AGENT_A] })),
    markApplied: vi.fn(async () => overview.agents[0]),
    actions: vi.fn(async () => ({
      agentId: AGENT_A,
      shared: true,
      actions: [
        { agentId: AGENT_A, action: "stop" as const, note: "container-keeps-running" as const },
        { agentId: AGENT_B, action: "keep" as const, note: "container-shared" as const },
      ],
    })),
    ...overrides,
  };
}

// The board actor carries the company the auth layer resolves for a signed-in
// operator, and the instance admin right the writes need.
const boardActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  companyIds: [COMPANY],
  isInstanceAdmin: true,
  memberships: [{ companyId: COMPANY, status: "active", membershipRole: "owner" }],
};
const agentActor = { type: "agent", agentId: "agent-a", companyId: COMPANY, source: "agent_key" };

const base = `/api/myrmidon/companies/${COMPANY}/container-scope`;

function appFor(actor: unknown, service = fakeService()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", containerScopeRoutes({ db: {} as Db, service }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  logActivity.mockClear();
});

describe("myrmidon(CONTAINER-SCOPE) routes", () => {
  it("answers the whole screen for a company member and writes no audit row", async () => {
    const res = await request(appFor(boardActor)).get(base).expect(200);
    expect(res.body).toMatchObject({
      containers: [{ containerKey: `scope:group-${GROUP_DEV}`, shared: true, limits: { memoryMb: 4096 } }],
      agents: [{ agentId: AGENT_A, restartRequired: true }],
      sharedAgentCount: 2,
    });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("refuses an agent: the surface is read by a board actor only", async () => {
    const res = await request(appFor(agentActor)).get(base).expect(403);
    expect(JSON.stringify(res.body)).toMatch(/Board access required/i);
  });

  it("hides the company from a board actor without access to it", async () => {
    const res = await request(appFor({ ...boardActor, companyIds: ["company-b"] })).get(base).expect(404);
    expect(JSON.stringify(res.body)).toMatch(/Company not found/i);
  });

  it("refuses a write from an agent", async () => {
    const res = await request(appFor(agentActor))
      .put(`${base}/instances`)
      .send({ kind: "group", ref: GROUP_DEV, mode: "per-scope" })
      .expect(403);
    expect(JSON.stringify(res.body)).toMatch(/Board access required/i);
  });

  it("refuses a write from a board actor who is not an instance admin", async () => {
    const res = await request(appFor({ ...boardActor, isInstanceAdmin: false }))
      .put(`${base}/instances`)
      .send({ kind: "group", ref: GROUP_DEV, mode: "per-scope" })
      .expect(403);
    expect(JSON.stringify(res.body)).toMatch(/Instance admin/i);
  });

  it("stores the container mode of an instance and writes the audit row", async () => {
    const res = await request(appFor(boardActor))
      .put(`${base}/instances`)
      .send({ kind: "group", ref: GROUP_DEV, mode: "per-scope" })
      .expect(200);
    expect(res.body).toMatchObject({
      instance: { kind: "group", ref: GROUP_DEV, mode: "per-scope" },
      restartRequired: [AGENT_A, AGENT_B],
    });
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(logActivity.mock.calls[0][1]).toMatchObject({
      companyId: COMPANY,
      action: "myrmidon.container_scope.instance_set",
      entityType: "container_scope_instance",
      entityId: `group:${GROUP_DEV}`,
      actorType: "user",
    });
  });

  it("rejects a body that is not a container mode", async () => {
    await request(appFor(boardActor))
      .put(`${base}/instances`)
      .send({ kind: "group", ref: GROUP_DEV, mode: "shared" })
      .expect(400);
  });

  it("answers 422 when the instance names nothing", async () => {
    const service = fakeService({ setInstance: vi.fn(async () => null) });
    await request(appFor(boardActor, service))
      .put(`${base}/instances`)
      .send({ kind: "group", ref: GROUP_DEV, mode: "per-scope" })
      .expect(422);
  });

  it("removes an instance and 404s one that is not there", async () => {
    await request(appFor(boardActor)).delete(`${base}/instances/group/${GROUP_DEV}`).expect(204);
    expect(logActivity.mock.calls[0][1]).toMatchObject({ action: "myrmidon.container_scope.instance_removed" });

    const service = fakeService({ removeInstance: vi.fn(async () => false) });
    await request(appFor(boardActor, service)).delete(`${base}/instances/group/${GROUP_DEV}`).expect(404);
  });

  it("rejects an unknown scope kind", async () => {
    await request(appFor(boardActor)).delete(`${base}/instances/team/${GROUP_DEV}`).expect(400);
  });

  it("recomputes the containers for a board actor", async () => {
    const res = await request(appFor(boardActor)).post(`${base}/recompute`).expect(200);
    expect(res.body).toMatchObject({ agents: 3, restartRequired: [AGENT_A] });
    expect(logActivity.mock.calls[0][1]).toMatchObject({ action: "myrmidon.container_scope.recomputed" });
  });

  it("marks the container a runtime applied and refuses one that does not match", async () => {
    const res = await request(appFor(boardActor))
      .post(`${base}/agents/${AGENT_A}/applied`)
      .send({ containerKey: `scope:group-${GROUP_DEV}` })
      .expect(200);
    expect(res.body).toMatchObject({ agent: { agentId: AGENT_A } });
    expect(logActivity.mock.calls[0][1]).toMatchObject({ action: "myrmidon.container_scope.container_applied" });

    const service = fakeService({ markApplied: vi.fn(async () => null) });
    await request(appFor(boardActor, service))
      .post(`${base}/agents/${AGENT_A}/applied`)
      .send({ containerKey: `agent:${AGENT_A}` })
      .expect(422);
  });

  it("answers 404 on an applied report for something that is not an agent id", async () => {
    await request(appFor(boardActor)).post(`${base}/agents/missing/applied`).send({ containerKey: "x" }).expect(404);
  });

  it("plans a pause for one member of a shared container", async () => {
    const res = await request(appFor(boardActor))
      .post(`${base}/agents/${AGENT_A}/actions`)
      .send({ kind: "pause" })
      .expect(200);
    expect(res.body).toMatchObject({
      agentId: AGENT_A,
      shared: true,
      actions: [
        { agentId: AGENT_A, action: "stop", note: "container-keeps-running" },
        { agentId: AGENT_B, action: "keep", note: "container-shared" },
      ],
    });

    const service = fakeService({ actions: vi.fn(async () => null) });
    await request(appFor(boardActor, service))
      .post(`${base}/agents/${AGENT_A}/actions`)
      .send({ kind: "pause" })
      .expect(404);
  });
});