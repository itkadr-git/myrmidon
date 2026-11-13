// myrmidon(OPE-13026): external MCP connector policy enforcement & audit journal tests.
// Pure unit tests with a fake store and fake connector dispatcher (no database).

import { describe, expect, it, vi } from "vitest";
import {
  externalConnectorService,
  summarizePayload,
  type ConnectorDispatcher,
  type ConnectorPolicyStore,
  type ExternalConnectorGrantRow,
  type ExternalConnectorInvocationRow,
  type ExternalConnectorPendingApprovalRow,
} from "./service.js";
import type {
  ConnectorActionMode,
  InvokeConnectorActionRequest,
  PutConnectorPolicyGrantsRequest,
} from "@myrmidon/shared";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTOR_ID = "test-system";

function createMemoryStore(): {
  store: ConnectorPolicyStore;
  grants: ExternalConnectorGrantRow[];
  invocations: ExternalConnectorInvocationRow[];
  approvals: ExternalConnectorPendingApprovalRow[];
} {
  const grants: ExternalConnectorGrantRow[] = [];
  const invocations: ExternalConnectorInvocationRow[] = [];
  const approvals: ExternalConnectorPendingApprovalRow[] = [];
  let idCounter = 1;

  const store: ConnectorPolicyStore = {
    async agentExists(companyId, agentId) {
      return companyId === COMPANY_ID && agentId === AGENT_ID;
    },

    async listGrants(companyId, query) {
      return grants.filter((g) => {
        if (g.companyId !== companyId || !g.enabled) return false;
        if (query.agentId && g.agentId !== query.agentId) return false;
        if (query.connectorId && g.connectorId !== query.connectorId) return false;
        return true;
      });
    },

    async replaceGrants(companyId, agentId, connectorId, createdBy, newGrants) {
      // Remove previous grants for this pair
      for (let i = grants.length - 1; i >= 0; i--) {
        if (
          grants[i].companyId === companyId &&
          grants[i].agentId === agentId &&
          grants[i].connectorId === connectorId
        ) {
          grants.splice(i, 1);
        }
      }
      const now = new Date();
      const created: ExternalConnectorGrantRow[] = newGrants.map((g) => ({
        id: `grant-${idCounter++}`,
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
      const entry: ExternalConnectorInvocationRow = {
        id: `inv-${idCounter++}`,
        createdAt: new Date(),
        ...row,
      };
      invocations.push(entry);
      return entry;
    },

    async insertPendingApproval(row) {
      const entry: ExternalConnectorPendingApprovalRow = {
        id: `appr-${idCounter++}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...row,
      };
      approvals.push(entry);
      return entry;
    },

    async findPendingApproval(companyId, id) {
      return approvals.find((a) => a.companyId === companyId && a.id === id) ?? null;
    },

    async resolvePendingApproval(companyId, id, status, resolvedBy, resolvedAt) {
      const found = approvals.find((a) => a.companyId === companyId && a.id === id);
      if (!found) throw new Error("not found");
      found.status = status;
      found.resolvedBy = resolvedBy;
      found.resolvedAt = resolvedAt;
      found.updatedAt = resolvedAt;
      return found;
    },

    async listPendingApprovals(companyId, status) {
      return approvals.filter((a) => a.companyId === companyId && (!status || a.status === status));
    },

    async queryJournal(companyId, query) {
      const filtered = invocations.filter((inv) => {
        if (inv.companyId !== companyId) return false;
        if (query.agentId && inv.agentId !== query.agentId) return false;
        if (query.connectorId && inv.connectorId !== query.connectorId) return false;
        if (query.actionId && inv.actionId !== query.actionId) return false;
        if (query.outcome && inv.outcome !== query.outcome) return false;
        return true;
      });
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      return {
        rows: filtered.slice(offset, offset + limit),
        total: filtered.length,
      };
    },
  };

  return { store, grants, invocations, approvals };
}

function createFakeDispatcher(): {
  dispatcher: ConnectorDispatcher;
  calls: InvokeConnectorActionRequest[];
} {
  const calls: InvokeConnectorActionRequest[] = [];
  const dispatcher: ConnectorDispatcher = async (req) => {
    calls.push(req);
    return {
      ok: true,
      result: { executed: true, action: req.actionId },
    };
  };
  return { dispatcher, calls };
}

describe("externalConnectorService enforcement (OPE-13026)", () => {
  const actionsCatalog: Record<string, ConnectorActionMode> = {
    "task:read": "read",
    "task:write": "write",
    "task:purge": "confirm",
  };

  const testActionModeResolver = (_conn: string, actionId: string) => actionsCatalog[actionId] ?? null;

  it("fails closed when agent has no grants: denied before dispatch with an immutable journal record", async () => {
    const { store, invocations } = createMemoryStore();
    const { dispatcher, calls } = createFakeDispatcher();
    const svc = externalConnectorService({} as never, { store, actionModeResolver: testActionModeResolver });

    const req: InvokeConnectorActionRequest = {
      actor: { type: "agent", id: AGENT_ID },
      connectorId: CONNECTOR_ID,
      actionId: "task:read",
      payload: { id: "123" },
    };

    const res = await svc.invoke(COMPANY_ID, req, dispatcher);
    expect(res.decision).toBe("denied");
    expect(calls).toHaveLength(0); // NEVER dispatched
    expect(res.journalEntry.outcome).toBe("denied");
    expect(res.journalEntry.reason).toBe("no_grant");
    expect(invocations).toHaveLength(1);
    expect(invocations[0].outcome).toBe("denied");
  });

  it("when agent is granted read only: read succeeds and write is denied before dispatch", async () => {
    const { store, invocations } = createMemoryStore();
    const { dispatcher, calls } = createFakeDispatcher();
    const svc = externalConnectorService({} as never, { store, actionModeResolver: testActionModeResolver });

    // Grant read-only on connector
    await svc.putGrants(
      COMPANY_ID,
      {
        agentId: AGENT_ID,
        connectorId: CONNECTOR_ID,
        grants: [{ actionId: "*", mode: "read" }],
      },
      { actorId: "admin-user", actorType: "user" },
    );

    // 1. Read call: authorized & dispatched
    const readReq: InvokeConnectorActionRequest = {
      actor: { type: "agent", id: AGENT_ID },
      connectorId: CONNECTOR_ID,
      actionId: "task:read",
      payload: { filter: "open" },
    };
    const readRes = await svc.invoke(COMPANY_ID, readReq, dispatcher);
    expect(readRes.decision).toBe("allowed");
    expect(calls).toHaveLength(1);
    expect(readRes.journalEntry.outcome).toBe("success");
    expect(readRes.journalEntry.reason).toBe("dispatched_allowed");

    // 2. Write call: denied BEFORE dispatch, call count stays 1
    const writeReq: InvokeConnectorActionRequest = {
      actor: { type: "agent", id: AGENT_ID },
      connectorId: CONNECTOR_ID,
      actionId: "task:write",
      payload: { title: "new task" },
    };
    const writeRes = await svc.invoke(COMPANY_ID, writeReq, dispatcher);
    expect(writeRes.decision).toBe("denied");
    expect(calls).toHaveLength(1); // STILL 1, no dispatch
    expect(writeRes.journalEntry.outcome).toBe("denied");
    expect(writeRes.journalEntry.reason).toBe("mode_denied_read_only");

    // Both calls recorded in immutable journal
    expect(invocations).toHaveLength(2);
    expect(invocations[0].outcome).toBe("success");
    expect(invocations[1].outcome).toBe("denied");
  });

  it("when mode requires human confirmation: call is pending and NO external request is sent", async () => {
    const { store, invocations, approvals } = createMemoryStore();
    const { dispatcher, calls } = createFakeDispatcher();
    const svc = externalConnectorService({} as never, { store, actionModeResolver: testActionModeResolver });

    // Grant write to agent
    await svc.putGrants(
      COMPANY_ID,
      {
        agentId: AGENT_ID,
        connectorId: CONNECTOR_ID,
        grants: [{ actionId: "*", mode: "write" }],
      },
      { actorId: "admin-user", actorType: "user" },
    );

    // Call a confirm-mode action (task:purge)
    const purgeReq: InvokeConnectorActionRequest = {
      actor: { type: "agent", id: AGENT_ID },
      connectorId: CONNECTOR_ID,
      actionId: "task:purge",
      payload: { force: true },
    };

    const res = await svc.invoke(COMPANY_ID, purgeReq, dispatcher);
    expect(res.decision).toBe("pending");
    expect(calls).toHaveLength(0); // ZERO external requests sent!
    expect(res.journalEntry.outcome).toBe("pending_confirmation");
    expect(res.journalEntry.pendingApprovalId).toBeTruthy();

    // Pending approval state created
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe("pending");
    expect(approvals[0].actionId).toBe("task:purge");

    // Journal contains pending_confirmation
    expect(invocations).toHaveLength(1);
    expect(invocations[0].outcome).toBe("pending_confirmation");
  });

  it("pending approval can be rejected by a human: records denied_rejected_approval and no dispatch", async () => {
    const { store, invocations, approvals } = createMemoryStore();
    const { dispatcher, calls } = createFakeDispatcher();
    const svc = externalConnectorService({} as never, { store, actionModeResolver: testActionModeResolver });

    await svc.putGrants(
      COMPANY_ID,
      {
        agentId: AGENT_ID,
        connectorId: CONNECTOR_ID,
        grants: [{ actionId: "*", mode: "confirm" }], // all actions require confirm
      },
      { actorId: "admin-user", actorType: "user" },
    );

    const req: InvokeConnectorActionRequest = {
      actor: { type: "agent", id: AGENT_ID },
      connectorId: CONNECTOR_ID,
      actionId: "task:read",
      payload: { id: 1 },
    };

    const invokeRes = await svc.invoke(COMPANY_ID, req, dispatcher);
    expect(invokeRes.decision).toBe("pending");
    const approvalId = approvals[0].id;

    // Human rejects the approval
    const resolveRes = await svc.resolvePendingApproval(
      COMPANY_ID,
      approvalId,
      "rejected",
      "user-operator-1",
      dispatcher,
    );

    expect(resolveRes.resolved).toBe(true);
    expect(resolveRes.decision).toBe("rejected");
    expect(resolveRes.approval.status).toBe("rejected");
    expect(calls).toHaveLength(0); // Still 0 calls dispatched
    expect(resolveRes.journalEntry.outcome).toBe("denied_rejected_approval");

    // Cannot resolve twice
    await expect(
      svc.resolvePendingApproval(COMPANY_ID, approvalId, "approved", "user-operator-1", dispatcher),
    ).rejects.toThrow(/already resolved/);
  });

  it("pending approval can be approved by a human: dispatches call and records approved_dispatch", async () => {
    const { store, invocations, approvals } = createMemoryStore();
    const { dispatcher, calls } = createFakeDispatcher();
    const svc = externalConnectorService({} as never, { store, actionModeResolver: testActionModeResolver });

    await svc.putGrants(
      COMPANY_ID,
      {
        agentId: AGENT_ID,
        connectorId: CONNECTOR_ID,
        grants: [{ actionId: "*", mode: "confirm" }],
      },
      { actorId: "admin-user", actorType: "user" },
    );

    const req: InvokeConnectorActionRequest = {
      actor: { type: "agent", id: AGENT_ID },
      connectorId: CONNECTOR_ID,
      actionId: "task:read",
      payload: { id: "item-42" },
    };

    await svc.invoke(COMPANY_ID, req, dispatcher);
    expect(calls).toHaveLength(0);
    const approvalId = approvals[0].id;

    // Human approves
    const resolveRes = await svc.resolvePendingApproval(
      COMPANY_ID,
      approvalId,
      "approved",
      "user-operator-1",
      dispatcher,
    );

    expect(resolveRes.resolved).toBe(true);
    expect(resolveRes.decision).toBe("approved");
    expect(resolveRes.approval.status).toBe("approved");
    expect(calls).toHaveLength(1); // Dispatched upon human approval!
    expect(calls[0].payload).toEqual({ id: "item-42" });
    expect(resolveRes.journalEntry.outcome).toBe("approved_dispatch");
  });

  it("action-specific grant overrides wildcard grant; explicit deny wins", async () => {
    const { store } = createMemoryStore();
    const { dispatcher, calls } = createFakeDispatcher();
    const svc = externalConnectorService({} as never, { store, actionModeResolver: testActionModeResolver });

    // Grant wildcard write, but deny task:write specifically
    await svc.putGrants(
      COMPANY_ID,
      {
        agentId: AGENT_ID,
        connectorId: CONNECTOR_ID,
        grants: [
          { actionId: "*", mode: "write" },
          { actionId: "task:write", mode: "deny" },
        ],
      },
      { actorId: "admin", actorType: "user" },
    );

    // task:read passes under wildcard write
    const r1 = await svc.invoke(
      COMPANY_ID,
      { actor: { type: "agent", id: AGENT_ID }, connectorId: CONNECTOR_ID, actionId: "task:read", payload: {} },
      dispatcher,
    );
    expect(r1.decision).toBe("allowed");
    expect(calls).toHaveLength(1);

    // task:write is denied due to explicit deny override
    const r2 = await svc.invoke(
      COMPANY_ID,
      { actor: { type: "agent", id: AGENT_ID }, connectorId: CONNECTOR_ID, actionId: "task:write", payload: {} },
      dispatcher,
    );
    expect(r2.decision).toBe("denied");
    expect(r2.journalEntry.reason).toBe("mode_denied");
    expect(calls).toHaveLength(1); // No new dispatch
  });

  it("audit journal records actor, connector, action, outcome, and redacts sensitive payload fields", async () => {
    const { store, invocations } = createMemoryStore();
    const { dispatcher } = createFakeDispatcher();
    const svc = externalConnectorService({} as never, { store, actionModeResolver: testActionModeResolver });

    await svc.putGrants(
      COMPANY_ID,
      {
        agentId: AGENT_ID,
        connectorId: CONNECTOR_ID,
        grants: [{ actionId: "*", mode: "write" }],
      },
      { actorId: "admin", actorType: "user" },
    );

    const payload = {
      apiKey: "super-secret-12345",
      password: "mypassword",
      targetId: "doc-99",
      nested: { bearerToken: "xyz", note: "public note" },
    };

    const res = await svc.invoke(
      COMPANY_ID,
      { actor: { type: "agent", id: AGENT_ID }, connectorId: CONNECTOR_ID, actionId: "task:write", payload },
      dispatcher,
    );

    expect(res.decision).toBe("allowed");
    const summary = res.journalEntry.payloadSummary;
    expect(summary).toBeTruthy();
    expect(summary).not.toContain("super-secret-12345");
    expect(summary).not.toContain("mypassword");
    expect(summary).not.toContain("xyz");
    expect(summary).toContain("[redacted]");
    expect(summary).toContain("doc-99");
    expect(summary).toContain("public note");

    // Journal page query returns the entry
    const page = await svc.queryJournal(COMPANY_ID, { connectorId: CONNECTOR_ID });
    expect(page.total).toBe(1);
    expect(page.entries[0].actionId).toBe("task:write");
    expect(page.entries[0].actorId).toBe(AGENT_ID);
  });
});
