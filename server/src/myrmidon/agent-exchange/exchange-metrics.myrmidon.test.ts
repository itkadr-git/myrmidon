// server/src/myrmidon/agent-exchange/exchange-metrics.myrmidon.test.ts
//
// myrmidon(1.7 AGENT-EXCHANGE-METRICS, OPE-12097): the two acceptance
// criteria of the ticket, run against the real engine with a fake model port
// and an in-memory store, and against the stats route with a stubbed store:
//
//  1. A finished exchange session increments `exchanges_started` /
//     `exchanges_completed` on GET /api/agents/:id/stats.
//  2. An agent with no sessions gets zeros.

import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import { DEFAULT_AGENT_EXCHANGE_SETTINGS, type AgentExchangeParticipantSpec } from "@myrmidon/shared";
import type { AgentExchangeMessage, AgentExchangeRoom } from "@myrmidon/shared";
import {
  finalizeRoom,
  openRoom,
  runNextRound,
  stopRoom,
  type AgentExchangeEngineDeps,
  type AgentExchangeModelCallResult,
  type AgentExchangeModelPort,
  type AgentExchangeStore,
} from "./engine.js";
import { HttpError } from "../../errors.js";
import { agentRoutes } from "../../routes/agents.js";

// ---------------------------------------------------------------------------
// In-memory store (mirrors engine.myrmidon.test.ts) + the session counter.
// ---------------------------------------------------------------------------

const COMPANY_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ISSUE_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const AGENT_A = "cccccccc-3333-4333-8333-333333333331";
const AGENT_B = "cccccccc-3333-4333-8333-333333333332";

function participant(agentId: string): AgentExchangeParticipantSpec {
  return { agentId, label: `agent-${agentId.slice(-2)}`, providerId: "provider", model: "test-model" };
}

function inMemoryStore(): AgentExchangeStore & { rooms: AgentExchangeRoom[] } {
  let idCounter = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`;
  const stamp = () => new Date("2026-11-09T06:00:00.000Z").toISOString();
  const rooms: AgentExchangeRoom[] = [];
  const messages: AgentExchangeMessage[] = [];
  return {
    rooms,
    async insertRoom(record) {
      const room: AgentExchangeRoom = {
        id: nextId(),
        companyId: record.companyId,
        issueId: record.issueId,
        status: record.status,
        openerType: record.openerType,
        openerId: record.openerId,
        stopperType: record.stopperType,
        stopperId: record.stopperId,
        participants: record.participants,
        finisher: record.finisher,
        maxRounds: record.maxRounds,
        tokenBudget: record.tokenBudget,
        tokensUsed: 0,
        costCents: 0,
        currentRound: 0,
        stopReason: null,
        summaryDocumentKey: null,
        judge: null,
        createdAt: stamp(),
        closedAt: null,
      };
      rooms.push(room);
      return room;
    },
    async getRoom(roomId) {
      return rooms.find((r) => r.id === roomId) ?? null;
    },
    async updateRoom(roomId, patch) {
      const room = rooms.find((r) => r.id === roomId);
      if (!room) throw new Error("room not found");
      Object.assign(room, patch, { closedAt: patch.closedAt ? patch.closedAt.toISOString() : room.closedAt });
      return room;
    },
    async listRooms(companyId, issueId) {
      return rooms.filter((r) => r.companyId === companyId && r.issueId === issueId);
    },
    async countAgentSessions(agentId) {
      const mine = rooms.filter((room) => room.participants.some((p) => p.agentId === agentId));
      return {
        started: mine.length,
        completed: mine.filter((room) => room.status === "completed").length,
      };
    },
    async insertMessage(input) {
      const message: AgentExchangeMessage = {
        id: nextId(),
        roomId: input.roomId,
        round: input.round,
        participantIndex: input.participantIndex,
        status: "pending",
        content: null,
        error: null,
        promptTokens: 0,
        completionTokens: 0,
        costCents: 0,
        createdAt: stamp(),
        completedAt: null,
      };
      messages.push(message);
      return message;
    },
    async updateMessage(messageId, patch) {
      const message = messages.find((m) => m.id === messageId);
      if (!message) throw new Error("message not found");
      const { completedAt, ...rest } = patch;
      Object.assign(message, rest, {
        completedAt: completedAt ? completedAt.toISOString() : message.completedAt,
      });
    },
    async listMessages(roomId) {
      return messages.filter((m) => m.roomId === roomId);
    },
    async failPendingMessages(roomId, error) {
      let count = 0;
      for (const message of messages) {
        if (message.roomId === roomId && message.status === "pending") {
          message.status = "error";
          message.error = error;
          count += 1;
        }
      }
      return count;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake model port (one deterministic answer per call).
// ---------------------------------------------------------------------------

function fakeModelPort(): AgentExchangeModelPort {
  let callCounter = 0;
  return {
    async call() {
      callCounter += 1;
      const result: AgentExchangeModelCallResult = {
        content: `answer ${callCounter}`,
        promptTokens: 10,
        completionTokens: 5,
      };
      return result;
    },
    async prices() {
      return { promptPriceUsdPerMillion: 0, completionPriceUsdPerMillion: 0 };
    },
  };
}

function engineDeps(store: AgentExchangeStore): AgentExchangeEngineDeps {
  return {
    store,
    models: fakeModelPort(),
    summaries: {
      async putSummary() {
        return "exchange:summary-key";
      },
    },
    // The default ships dark (enabled: false); the tests must turn the rooms on.
    settings: { ...DEFAULT_AGENT_EXCHANGE_SETTINGS, enabled: true },
    now: () => new Date("2026-11-09T06:01:00.000Z"),
  };
}

async function runSessionToCompletion(deps: AgentExchangeEngineDeps, agents: string[]): Promise<AgentExchangeRoom> {
  const room = await openRoom(deps, {
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    openerType: "user",
    openerId: "board",
    participants: agents.map(participant),
    prompt: "what did we learn?",
    issueTitle: "Exchange metrics",
  });
  await runNextRound(deps, room.id, "round 2: anything new?");
  return finalizeRoom(deps, room.id);
}

// ---------------------------------------------------------------------------
// The stats route: same wiring as agents.myrmidon.test.ts (mocked services,
// board actor, agentExchangeStore stubbed at the module boundary).
// ---------------------------------------------------------------------------

const testAgent = {
  id: AGENT_A,
  companyId: COMPANY_ID,
  name: "Test Agent",
  role: "engineer",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
};

const agentSvcMock = {
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  orgForCompany: vi.fn(),
  resolveByReference: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  activatePendingApproval: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  updatePermissions: vi.fn(),
  listConfigRevisions: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
};

vi.mock("../../services/index.js", () => ({
  agentService: vi.fn(() => agentSvcMock),
  agentInstructionsService: vi.fn(() => ({
    getBundle: vi.fn(),
    updateBundle: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    exportFiles: vi.fn(),
    materializeManagedBundle: vi.fn(),
  })),
  accessService: vi.fn(() => ({
    decide: vi.fn(async () => ({ allowed: true, reason: "allow", explanation: "" })),
    hasPermission: vi.fn(async () => true),
    canUser: vi.fn(async () => true),
    listPrincipalGrants: vi.fn(async () => []),
    ensureMembership: vi.fn(),
    setPrincipalPermission: vi.fn(),
    getMembership: vi.fn(),
  })),
  changeConsentGateService: vi.fn(() => ({
    assertConsented: vi.fn(async () => {}),
  })),
  approvalService: vi.fn(() => ({
    create: vi.fn(),
    listForIssue: vi.fn(),
    decide: vi.fn(),
  })),
  builtInAgentService: vi.fn(() => ({
    list: vi.fn(),
    get: vi.fn(),
  })),
  companySkillService: vi.fn(() => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveRequestedSkillEntries: vi.fn(),
  })),
  budgetService: vi.fn(() => ({
    listForCompany: vi.fn(),
    getForAgent: vi.fn(),
    setForAgent: vi.fn(),
  })),
  heartbeatService: vi.fn(() => ({})),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: vi.fn(() => ({})),
  issueRecoveryActionService: vi.fn(() => ({})),
  issueService: vi.fn(() => ({ addComment: vi.fn(), update: vi.fn() })),
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn(async (x: unknown) => x),
  workspaceOperationService: vi.fn(() => ({})),
}));

const countAgentSessionsMock = vi.fn(async () => ({ started: 0, completed: 0 }));
vi.mock("./store.js", () => ({
  agentExchangeStore: () => ({ countAgentSessions: countAgentSessionsMock }),
}));

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...((err.details as Record<string, unknown>) ?? {}) });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : "test error" });
}

function boardApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.actor = { type: "board", source: "local_implicit" };
    next();
  });
  app.use("/api", agentRoutes({} as never));
  app.use(errorHandler);
  return app;
}

async function primeAgentLookup() {
  agentSvcMock.getById.mockResolvedValue(testAgent);
}

// ---------------------------------------------------------------------------
// Criterion 1: a completed session increments both counters.
// ---------------------------------------------------------------------------

describe("agent exchange session counters (OPE-12097)", () => {
  it("a completed exchange session increments exchanges_started and exchanges_completed", async () => {
    const store = inMemoryStore();
    const deps = engineDeps(store);

    const room = await runSessionToCompletion(deps, [AGENT_A, AGENT_B]);
    expect(room.status).toBe("completed");
    expect(room.closedAt).not.toBeNull();

    expect(await store.countAgentSessions?.(AGENT_A)).toEqual({ started: 1, completed: 1 });
    expect(await store.countAgentSessions?.(AGENT_B)).toEqual({ started: 1, completed: 1 });
    // An agent who never joined counts nothing.
    expect(await store.countAgentSessions?.("dddddddd-4444-4444-8444-444444444444")).toEqual({
      started: 0,
      completed: 0,
    });

    await primeAgentLookup();
    countAgentSessionsMock.mockResolvedValueOnce({ started: 1, completed: 1 });
    const res = await request(boardApp()).get(`/api/agents/${AGENT_A}/stats`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exchanges_started: 1, exchanges_completed: 1 });
    expect(countAgentSessionsMock).toHaveBeenCalledWith(AGENT_A);
  });

  it("a stopped session counts as started but not completed", async () => {
    const store = inMemoryStore();
    const deps = engineDeps(store);

    const room = await openRoom(deps, {
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      openerType: "user",
      openerId: "board",
      participants: [participant(AGENT_A), participant(AGENT_B)],
      prompt: "what did we learn?",
      issueTitle: "Exchange metrics",
    });
    await runNextRound(deps, room.id, "round 2: anything new?");
    const stopped = await stopRoom(deps, { roomId: room.id, actorType: "user", actorId: "board" });
    expect(stopped.status).toBe("stopped");

    expect(await store.countAgentSessions?.(AGENT_A)).toEqual({ started: 1, completed: 0 });
  });

  // Criterion 2: no sessions -> zeros on the route.
  it("an agent without sessions reports zeros on GET /api/agents/:id/stats", async () => {
    await primeAgentLookup();
    countAgentSessionsMock.mockResolvedValueOnce({ started: 0, completed: 0 });
    const res = await request(boardApp()).get(`/api/agents/${AGENT_A}/stats`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exchanges_started: 0, exchanges_completed: 0 });
  });

  it("counters flow through the store boundary to the route", async () => {
    await primeAgentLookup();
    countAgentSessionsMock.mockResolvedValueOnce({ started: 2, completed: 2 });
    const res = await request(boardApp()).get(`/api/agents/${AGENT_A}/stats`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exchanges_started: 2, exchanges_completed: 2 });
  });

  it("an unknown agent id is 404, not zeros", async () => {
    agentSvcMock.getById.mockResolvedValueOnce(null);
    const res = await request(boardApp()).get(`/api/agents/${AGENT_A}/stats`);
    expect(res.status).toBe(404);
  });
});
