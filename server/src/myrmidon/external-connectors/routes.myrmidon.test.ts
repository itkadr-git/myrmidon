// myrmidon(OPE-13026): external-connectors routes tests — supertest against
// the real router with a fake service-backed store + fake dispatcher (no DB).
// Covers HTTP shape, authorization, fail-closed malformed input, and the
// 200/202/403 invoke decision mapping.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { externalConnectorsRoutes } from "./routes.js";
import { externalConnectorService, type ConnectorPolicyStore } from "./service.js";
import type {
  ExternalConnectorGrantRow,
  ExternalConnectorInvocationRow,
  ExternalConnectorPendingApprovalRow,
} from "./service.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const outsider = {
  type: "board",
  source: "session",
  userId: "user-b",
  isInstanceAdmin: false,
  companyIds: ["99999999-9999-4999-8999-999999999999"],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  keyId: "key-a",
};
const anonymous = { type: "none" };

function createMemoryStore(): ConnectorPolicyStore {
  const grants: ExternalConnectorGrantRow[] = [];
  const invocations: ExternalConnectorInvocationRow[] = [];
  const approvals: ExternalConnectorPendingApprovalRow[] = [];
  let n = 1;
  return {
    async agentExists(companyId, agentId) {
      return companyId === COMPANY_ID && agentId === AGENT_ID;
    },
    async listGrants(companyId, query) {
      return grants.filter(
        (g) =>
          g.companyId === companyId &&
          g.enabled &&
          (!query.agentId || g.agentId === query.agentId) &&
          (!query.connectorId || g.connectorId === query.connectorId),
      );
    },
    async replaceGrants(companyId, agentId, connectorId, createdBy, newGrants) {
      for (let i = grants.length - 1; i >= 0; i--) {
        if (
          grants[i].companyId === companyId &&
          grants[i].agentId === agentId &&
          grants[i].connectorId === connectorId
        )
          grants.splice(i, 1);
      }
      const now = new Date();
      const created = newGrants.map((g) => ({
        id: `g${n++}`,
        companyId,
        agentId,
        connectorId,
        actionId: g.actionId,
        mode: g.mode,
        createdBy,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }));
      grants.push(...created);
      return created;
    },
    async insertInvocation(row) {
      const e = { id: `i${n++}`, createdAt: new Date(), ...row };
      invocations.push(e);
      return e;
    },
    async insertPendingApproval(row) {
      const e = { id: `a${n++}`, createdAt: new Date(), updatedAt: new Date(), ...row };
      approvals.push(e);
      return e;
    },
    async findPendingApproval(companyId, id) {
      return approvals.find((a) => a.companyId === companyId && a.id === id) ?? null;
    },
    async resolvePendingApproval(companyId, id, status, resolvedBy, resolvedAt) {
      const f = approvals.find((a) => a.companyId === companyId && a.id === id);
      if (!f) throw new Error("not found");
      f.status = status;
      f.resolvedBy = resolvedBy;
      f.resolvedAt = resolvedAt;
      f.updatedAt = resolvedAt;
      return f;
    },
    async listPendingApprovals(companyId, status) {
      return approvals.filter((a) => a.companyId === companyId && (!status || a.status === status));
    },
    async queryJournal(companyId, query) {
      const rows = invocations.filter((i) => {
        if (i.companyId !== companyId) return false;
        if (query.agentId && i.agentId !== query.agentId) return false;
        if (query.connectorId && i.connectorId !== query.connectorId) return false;
        if (query.actionId && i.actionId !== query.actionId) return false;
        if (query.outcome && i.outcome !== query.outcome) return false;
        return true;
      });
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      return { rows: rows.slice(offset, offset + limit), total: rows.length };
    },
  };
}

const actionModes: Record<string, string> = {
  "task:read": "read",
  "task:write": "write",
  "task:purge": "confirm",
};

function app(actor: unknown) {
  const svc = externalConnectorService({} as never, {
    store: createMemoryStore(),
    actionModeResolver: (_c: string, a: string) => actionModes[a] ?? null,
  });
  const dispatched: unknown[] = [];
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    externalConnectorsRoutes({} as never, {
      service: svc,
      dispatcher: async (req) => {
        dispatched.push(req);
        return { ok: true, result: { executed: true } };
      },
    }),
  );
  server.use(errorHandler);
  return { server, svc, dispatched };
}

const BASE = "/api/myrmidon/external-connectors";

describe("myrmidon(OPE-13026) external-connectors routes", () => {
  it("PUT /grants stores grants and GET /grants lists them", async () => {
    const a = app(member);
    await request(a.server)
      .put(`${BASE}/grants`)
      .send({
        agentId: AGENT_ID,
        connectorId: "test-system",
        grants: [{ actionId: "*", mode: "read" }],
      })
      .expect(200)
      .then((res) => {
        expect(res.body.grants).toHaveLength(1);
        expect(res.body.grants[0].mode).toBe("read");
      });

    await request(a.server)
      .get(`${BASE}/grants?agentId=${AGENT_ID}&connectorId=test-system`)
      .expect(200)
      .then((res) => {
        expect(res.body.grants).toHaveLength(1);
      });
  });

  it("PUT /grants with an empty grants list fails validation (fail closed)", async () => {
    const a = app(member);
    await request(a.server)
      .put(`${BASE}/grants`)
      .send({ agentId: AGENT_ID, connectorId: "test-system", grants: [] })
      .expect(400);
  });

  it("PUT /grants rejects an unknown agent with 404", async () => {
    const a = app(member);
    await request(a.server)
      .put(`${BASE}/grants`)
      .send({
        agentId: "33333333-3333-4333-8333-333333333333",
        connectorId: "test-system",
        grants: [{ actionId: "*", mode: "read" }],
      })
      .expect(404);
  });

  it("POST /invoke allows a granted read and dispatches", async () => {
    const a = app(agentActor);
    await a.svc.putGrants(
      COMPANY_ID,
      { agentId: AGENT_ID, connectorId: "test-system", grants: [{ actionId: "*", mode: "read" }] },
      { actorId: "admin", actorType: "user" },
    );

    const res = await request(a.server)
      .post(`${BASE}/invoke`)
      .send({
        actor: { type: "agent", id: AGENT_ID },
        connectorId: "test-system",
        actionId: "task:read",
        payload: { filter: "open" },
      })
      .expect(200);

    expect(res.body.decision).toBe("allowed");
    expect(res.body.journalEntry.outcome).toBe("success");
    expect(a.dispatched).toHaveLength(1);
  });

  it("POST /invoke denies a write under a read-only grant before dispatch (403 + journal)", async () => {
    const a = app(agentActor);
    await a.svc.putGrants(
      COMPANY_ID,
      { agentId: AGENT_ID, connectorId: "test-system", grants: [{ actionId: "*", mode: "read" }] },
      { actorId: "admin", actorType: "user" },
    );

    const res = await request(a.server)
      .post(`${BASE}/invoke`)
      .send({
        actor: { type: "agent", id: AGENT_ID },
        connectorId: "test-system",
        actionId: "task:write",
        payload: { title: "x" },
      })
      .expect(403);

    expect(res.body.decision).toBe("denied");
    expect(res.body.journalEntry.outcome).toBe("denied");
    expect(res.body.journalEntry.reason).toBe("mode_denied_read_only");
    expect(a.dispatched).toHaveLength(0);

    // Journal is queryable
    await request(a.server)
      .get(`${BASE}/journal?outcome=denied`)
      .expect(200)
      .then((r) => {
        expect(r.body.total).toBe(1);
        expect(r.body.entries[0].actionId).toBe("task:write");
      });
  });

  it("POST /invoke on a confirm action returns 202 pending and no external request", async () => {
    const a = app(agentActor);
    await a.svc.putGrants(
      COMPANY_ID,
      { agentId: AGENT_ID, connectorId: "test-system", grants: [{ actionId: "*", mode: "write" }] },
      { actorId: "admin", actorType: "user" },
    );

    const res = await request(a.server)
      .post(`${BASE}/invoke`)
      .send({
        actor: { type: "agent", id: AGENT_ID },
        connectorId: "test-system",
        actionId: "task:purge",
        payload: { force: true },
      })
      .expect(202);

    expect(res.body.decision).toBe("pending");
    expect(res.body.journalEntry.outcome).toBe("pending_confirmation");
    expect(res.body.journalEntry.pendingApprovalId).toBeTruthy();
    expect(a.dispatched).toHaveLength(0);
  });

  it("POST /invoke with a malformed body fails closed (400) and never dispatches", async () => {
    const a = app(agentActor);
    await request(a.server)
      .post(`${BASE}/invoke`)
      .send({ connectorId: "test-system" })
      .expect(400);
    expect(a.dispatched).toHaveLength(0);
  });

  it("POST /invoke with an unknown connector action is denied with action_not_found", async () => {
    const a = app(agentActor);
    await a.svc.putGrants(
      COMPANY_ID,
      { agentId: AGENT_ID, connectorId: "test-system", grants: [{ actionId: "*", mode: "write" }] },
      { actorId: "admin", actorType: "user" },
    );
    const res = await request(a.server)
      .post(`${BASE}/invoke`)
      .send({
        actor: { type: "agent", id: AGENT_ID },
        connectorId: "test-system",
        actionId: "task:missing",
        payload: {},
      })
      .expect(403);
    expect(res.body.journalEntry.reason).toBe("action_not_found");
  });

  it("POST /invoke unauthenticated is rejected 401", async () => {
    const a = app(anonymous);
    await request(a.server)
      .post(`${BASE}/invoke`)
      .send({
        actor: { type: "agent", id: AGENT_ID },
        connectorId: "test-system",
        actionId: "task:read",
        payload: {},
      })
      .expect(401);
  });

  it("grants/journal endpoints reject a board outsider for another company", async () => {
    const a = app(outsider);
    await request(a.server).get(`${BASE}/grants?companyId=${COMPANY_ID}`).expect(403);
    await request(a.server).get(`${BASE}/journal?companyId=${COMPANY_ID}`).expect(403);
  });

  it("GET /grants without company context answers 422", async () => {
    const a = app({ ...member, companyIds: ["55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"] });
    await request(a.server).get(`${BASE}/grants`).expect(422);
  });

  it("pending approval resolve endpoint approves and dispatches", async () => {
    const a = app(agentActor);
    await a.svc.putGrants(
      COMPANY_ID,
      { agentId: AGENT_ID, connectorId: "test-system", grants: [{ actionId: "*", mode: "confirm" }] },
      { actorId: "admin", actorType: "user" },
    );
    await request(a.server)
      .post(`${BASE}/invoke`)
      .send({
        actor: { type: "agent", id: AGENT_ID },
        connectorId: "test-system",
        actionId: "task:read",
        payload: { id: "item-7" },
      })
      .expect(202);
    expect(a.dispatched).toHaveLength(0);

    const list = await request(a.server)
      .get(`${BASE}/pending-approvals?status=pending&companyId=${COMPANY_ID}`)
      .expect(200);
    const approvalId = list.body.approvals[0].id;

    await request(a.server)
      .post(`${BASE}/pending-approvals/${approvalId}/resolve`)
      .send({ decision: "approved", resolvedBy: "user-operator" })
      .expect(200)
      .then((r) => {
        expect(r.body.decision).toBe("approved");
        expect(r.body.journalEntry.outcome).toBe("approved_dispatch");
      });
    expect(a.dispatched).toHaveLength(1);
  });

  it("resolve endpoint rejects a second resolution with 409", async () => {
    const a = app(agentActor);
    await a.svc.putGrants(
      COMPANY_ID,
      { agentId: AGENT_ID, connectorId: "test-system", grants: [{ actionId: "*", mode: "confirm" }] },
      { actorId: "admin", actorType: "user" },
    );
    await request(a.server)
      .post(`${BASE}/invoke`)
      .send({
        actor: { type: "agent", id: AGENT_ID },
        connectorId: "test-system",
        actionId: "task:read",
        payload: {},
      })
      .expect(202);
    const list = await request(a.server).get(`${BASE}/pending-approvals`).expect(200);
    const approvalId = list.body.approvals[0].id;

    await request(a.server)
      .post(`${BASE}/pending-approvals/${approvalId}/resolve`)
      .send({ decision: "rejected", resolvedBy: "user-operator" })
      .expect(200);

    await request(a.server)
      .post(`${BASE}/pending-approvals/${approvalId}/resolve`)
      .send({ decision: "approved", resolvedBy: "user-operator" })
      .expect(409);
  });
});
