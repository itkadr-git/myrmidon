// server/src/myrmidon/agent-exchange/routes-private.myrmidon.test.ts
//
// myrmidon(1.7 PRIVATE-TASKS G1, OPE-12701): a private issue must be invisible
// to agent actors on every agent-exchange route that resolves the issue —
// answered with the SAME 404 the missing-issue path answers, and the engine
// must never run for an agent on a private issue. Board actors keep full
// access; agents keep full access on public issues.
//
// Matrix: five routes × {agent on private: 404 + engine untouched;
// board on private: works; agent on public: works}. The 404 for a private
// issue is also asserted byte-identical to the 404 for a nonexistent issue,
// so the response cannot leak the issue's existence to the agent.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentExchangeMessage,
  AgentExchangeParticipantSpec,
  AgentExchangeRoom,
} from "@myrmidon/shared";
import type { AgentExchangeEngineDeps, AgentExchangeStore } from "./engine.js";
import { agentExchangeRoutes, type AgentExchangeRoutesDeps } from "./routes.js";
import { errorHandler } from "../../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Fixture world: one company, a private and a public issue, one open room on
// each. The fake Db answers only the routes' issue lookups; the fake store
// counts every engine-reachable store call.
// ---------------------------------------------------------------------------

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_ID = "12345678-1234-4123-8123-123456789abc";
const PRIVATE_ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PUBLIC_ISSUE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MISSING_ISSUE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PRIVATE_ROOM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PUBLIC_ROOM_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type IssueRow = { id: string; companyId: string; title: string; isPrivate: boolean };

const issueRows: Record<string, IssueRow> = {
  [PRIVATE_ISSUE_ID]: {
    id: PRIVATE_ISSUE_ID,
    companyId: COMPANY_ID,
    title: "Secret board task",
    isPrivate: true,
  },
  [PUBLIC_ISSUE_ID]: {
    id: PUBLIC_ISSUE_ID,
    companyId: COMPANY_ID,
    title: "Public task",
    isPrivate: false,
  },
};

const PARTICIPANTS: AgentExchangeParticipantSpec[] = [
  { agentId: null, label: "agent-a", providerId: PROVIDER_ID, model: "model-a" },
  { agentId: null, label: "agent-b", providerId: PROVIDER_ID, model: "model-b" },
];

function roomOf(issueId: string, roomId: string): AgentExchangeRoom {
  return {
    id: roomId,
    companyId: COMPANY_ID,
    issueId,
    status: "open",
    // Opened by the board user the actor fixture impersonates (userId
    // AGENT_ID), so both stop happy-paths hit the engine's opener rule.
    openerType: "user",
    openerId: AGENT_ID,
    stopperType: "user",
    stopperId: AGENT_ID,
    participants: PARTICIPANTS,
    finisher: null,
    maxRounds: 3,
    tokenBudget: 100_000,
    tokensUsed: 0,
    costCents: 0,
    stopReason: null,
    summaryDocumentKey: null,
    judge: null,
    currentRound: 1,
    createdAt: "2026-11-11T00:00:00.000Z",
    closedAt: null,
  };
}

let messageSeq = 0;

/** The in-memory store behind both the routes' `store` and the engine deps. */
function makeStore(): AgentExchangeStore & { calls: { listRooms: number; insertRoom: number; messages: number } } {
  const rooms = new Map<string, AgentExchangeRoom>();
  const roomsByIssue = new Map<string, string[]>();
  const counter = { listRooms: 0, insertRoom: 0, messages: 0 };

  const register = (room: AgentExchangeRoom) => {
    rooms.set(room.id, room);
    roomsByIssue.set(room.issueId, [...(roomsByIssue.get(room.issueId) ?? []), room.id]);
  };
  register(roomOf(PRIVATE_ISSUE_ID, PRIVATE_ROOM_ID));
  register(roomOf(PUBLIC_ISSUE_ID, PUBLIC_ROOM_ID));

  return {
    calls: counter,
    async insertRoom(record) {
      counter.insertRoom += 1;
      messageSeq += 1;
      const room: AgentExchangeRoom = {
        ...record,
        id: `room-${messageSeq}`,
        tokensUsed: 0,
        costCents: 0,
        stopReason: null,
        summaryDocumentKey: null,
        judge: null,
        currentRound: 0,
        createdAt: "2026-11-11T00:00:00.000Z",
        closedAt: null,
      };
      register(room);
      return room;
    },
    async getRoom(roomId) {
      return rooms.get(roomId) ?? null;
    },
    async updateRoom(roomId, patch) {
      const room = rooms.get(roomId);
      if (!room) throw new Error(`no room ${roomId}`);
      Object.assign(room, patch);
      return room;
    },
    async listRooms(companyId, issueId) {
      counter.listRooms += 1;
      return (roomsByIssue.get(issueId) ?? [])
        .map((id) => rooms.get(id)!)
        .filter((room) => room.companyId === companyId);
    },
    async insertMessage() {
      counter.messages += 1;
      messageSeq += 1;
      const message: AgentExchangeMessage = {
        id: `msg-${messageSeq}`,
        roomId: "unknown-room",
        round: 1,
        participantIndex: 0,
        status: "pending",
        content: null,
        error: null,
        promptTokens: 0,
        completionTokens: 0,
        costCents: 0,
        createdAt: "2026-11-11T00:00:00.000Z",
        completedAt: null,
      };
      return message;
    },
    async updateMessage() {},
    async listMessages() {
      return [];
    },
  };
}

/**
 * The fake Db answers the routes' issue lookups. The real call shape is
 * `db.select({...}).from(issues).where(eq(issues.id, id)).then(...)`; the
 * drizzle `eq` condition carries the looked-up id in a `Param` chunk of
 * `queryChunks`, and the projection is whatever the route selected.
 */
function makeDb() {
  return {
    select: (projection: Record<string, unknown>) => {
      const chain = {
        condition: null as unknown,
        from: () => chain,
        where: (condition: unknown) => {
          chain.condition = condition;
          return chain;
        },
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => {
          let id: string | undefined;
          const chunks = (chain.condition as { queryChunks?: Array<{ value?: unknown }> })
            ?.queryChunks;
          if (Array.isArray(chunks)) {
            for (const chunk of chunks) {
              if (
                chunk &&
                typeof chunk === "object" &&
                chunk.constructor?.name === "Param" &&
                typeof chunk.value === "string"
              ) {
                id = chunk.value;
              }
            }
          }
          const row = typeof id === "string" ? issueRows[id] : undefined;
          const projected = row
            ? Object.fromEntries(
                Object.keys(projection).map((key) => [key, (row as Record<string, unknown>)[key]]),
              )
            : undefined;
          return Promise.resolve(projected ? [projected] : []).then(resolve, reject);
        },
      };
      return chain;
    },
  } as unknown as AgentExchangeRoutesDeps["db"];
}

const ENABLED_SETTINGS = {
  settings: {
    enabled: true,
    maxParticipants: 8,
    maxRounds: 3,
    tokenBudget: 1_000_000,
    responseTimeoutMs: 120_000,
  },
  sources: {
    enabled: "settings",
    maxParticipants: "settings",
    maxRounds: "settings",
    tokenBudget: "settings",
    responseTimeoutMs: "settings",
  },
} as const;

/** No-op model port and summary sink: rounds land without any model call. */
function makeEngineExtras() {
  const modelCalls: string[] = [];
  const models = {
    async call(input: { messages: Array<{ role: string; content: string }> }) {
      modelCalls.push(input.messages.map((m) => m.content).join("\n"));
      return { content: "answer", promptTokens: 2, completionTokens: 2 };
    },
    async prices() {
      return { promptPriceUsdPerMillion: null, completionPriceUsdPerMillion: null };
    },
  };
  const summaries = {
    async putSummary(input: { issueId: string }) {
      void input;
      return "doc-key";
    },
  };
  return { models, summaries, modelCalls };
}

type World = {
  app: express.Express;
  store: ReturnType<typeof makeStore>;
  modelCalls: string[];
};

function createApp(): World {
  const store = makeStore();
  const { models, summaries, modelCalls } = makeEngineExtras();
  const deps: AgentExchangeRoutesDeps = {
    db: makeDb(),
    store,
    engineDeps: (): AgentExchangeEngineDeps => ({
      store,
      models,
      summaries,
      settings: ENABLED_SETTINGS.settings,
    }),
    updateSettings: async () => ({}),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentExchangeRoutes(deps));
  app.use(errorHandler);
  return { app, store, modelCalls };
}

/** The actor middleware reads this before each request. */
let actor: Record<string, unknown> = {};

function actorAgent() {
  actor = {
    type: "agent",
    agentId: AGENT_ID,
    companyId: COMPANY_ID,
    source: "agent_key",
  };
}

function actorBoard() {
  actor = {
    type: "board",
    source: "local_implicit",
    isInstanceAdmin: true,
    userId: AGENT_ID,
    companyIds: [COMPANY_ID],
  };
}

beforeEach(() => {
  actorBoard();
  // The route resolves settings through instanceSettingsService(deps.db); the
  // fake Db cannot answer that read, the reader fails safe-closed (enabled:
  // false), and POST /rooms would answer 422 feature_disabled. The env
  // override is the same forced switch the resolver honors in production.
  process.env.MYRMIDON_AGENT_EXCHANGE_ENABLED = "1";
});

afterEach(() => {
  // The env override must never leak into sibling test files.
  delete process.env.MYRMIDON_AGENT_EXCHANGE_ENABLED;
});

// ---------------------------------------------------------------------------
// Request helpers.
// ---------------------------------------------------------------------------

const ROOM_BODY = {
  issueId: PUBLIC_ISSUE_ID,
  participants: PARTICIPANTS.map((p) => ({
    agentId: p.agentId,
    label: p.label,
    providerId: p.providerId,
    model: p.model,
  })),
};

function postCreate(world: World, issueId: string) {
  return request(world.app)
    .post("/api/myrmidon/agent-exchange/rooms")
    .send({ ...ROOM_BODY, issueId });
}

function getListRooms(world: World, issueId: string) {
  return request(world.app).get(`/api/issues/${issueId}/agent-exchange/rooms`);
}

function postRounds(world: World, roomId: string) {
  return request(world.app).post(`/api/myrmidon/agent-exchange/rooms/${roomId}/rounds`);
}

function postFinalize(world: World, roomId: string) {
  return request(world.app).post(`/api/myrmidon/agent-exchange/rooms/${roomId}/finalize`);
}

function postStop(world: World, roomId: string) {
  return request(world.app).post(`/api/myrmidon/agent-exchange/rooms/${roomId}/stop`).send({});
}

/** The engine actually ran only if the store moved (a round writes messages). */
function engineRan(world: World): boolean {
  return world.store.calls.messages > 0 || world.store.calls.insertRoom > 0;
}

// ---------------------------------------------------------------------------
// The matrix.
// ---------------------------------------------------------------------------

describe("agent-exchange routes vs private issues (1.7 PRIVATE-TASKS G1)", () => {
  it("POST /rooms: agent on a private issue gets the missing-issue 404 and openRoom never runs", async () => {
    const world = createApp();
    actorAgent();

    const missing = await postCreate(world, MISSING_ISSUE_ID);
    const notFoundBody = missing.body;
    expect(missing.status).toBe(404);

    const priv = await postCreate(world, PRIVATE_ISSUE_ID);
    expect(priv.status).toBe(missing.status);
    expect(priv.body).toEqual(notFoundBody);
    expect(engineRan(world)).toBe(false);
    expect(world.modelCalls).toEqual([]);
  });

  it("POST /rooms: agent on a public issue still opens a room (201)", async () => {
    const world = createApp();
    actorAgent();
    const res = await postCreate(world, PUBLIC_ISSUE_ID);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.issueId).toBe(PUBLIC_ISSUE_ID);
    expect(engineRan(world)).toBe(true);
    expect(world.modelCalls.length).toBeGreaterThan(0);
  });

  it("POST /rooms: board on a private issue still opens a room (201)", async () => {
    const world = createApp();
    const res = await postCreate(world, PRIVATE_ISSUE_ID);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.issueId).toBe(PRIVATE_ISSUE_ID);
    expect(engineRan(world)).toBe(true);
  });

  it("GET /issues/:id/agent-exchange/rooms: agent on a private issue gets the missing-issue 404 and store.listRooms never runs", async () => {
    const world = createApp();
    actorAgent();

    const missing = await getListRooms(world, MISSING_ISSUE_ID);
    const notFoundBody = missing.body;
    expect(missing.status).toBe(404);

    const priv = await getListRooms(world, PRIVATE_ISSUE_ID);
    expect(priv.status).toBe(404);
    expect(priv.body).toEqual(notFoundBody);
    expect(world.store.calls.listRooms).toBe(0);
  });

  it("GET /issues/:id/agent-exchange/rooms: agent on a public issue lists rooms; board on a private issue lists rooms", async () => {
    const world = createApp();

    actorAgent();
    const asAgent = await getListRooms(world, PUBLIC_ISSUE_ID);
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.map((room: AgentExchangeRoom) => room.id)).toEqual([PUBLIC_ROOM_ID]);
    expect(world.store.calls.listRooms).toBe(1);

    actorBoard();
    const asBoard = await getListRooms(world, PRIVATE_ISSUE_ID);
    expect(asBoard.status).toBe(200);
    expect(asBoard.body.map((room: AgentExchangeRoom) => room.id)).toEqual([PRIVATE_ROOM_ID]);
    expect(world.store.calls.listRooms).toBe(2);
  });

  it("POST /rooms/:roomId/rounds: agent on a private issue's room gets the missing-issue 404 and the round never runs", async () => {
    const world = createApp();
    actorAgent();

    const unknownRoom = await postRounds(world, "00000000-0000-4000-8000-000000000000");
    // A missing room answers 404 { error: "room_not_found", ... } — the
    // private-issue gate must not collide with the room-not-found contract,
    // so the private gate is compared against the missing-ISSUE 404 below.
    expect(unknownRoom.status).toBe(404);

    const missing = await postCreate(world, MISSING_ISSUE_ID);
    const notFoundBody = missing.body;

    const priv = await postRounds(world, PRIVATE_ROOM_ID);
    expect(priv.status).toBe(404);
    // Same body the missing-issue path answers (an `{ error, message }` pair,
    // no room_not_found code to distinguish private from nonexistent).
    expect(priv.body).toEqual(notFoundBody);
    expect(engineRan(world)).toBe(false);
    expect(world.modelCalls).toEqual([]);
  });

  it("POST /rooms/:roomId/rounds: agent on a public room runs a round; board on a private room runs a round", async () => {
    const world = createApp();

    actorAgent();
    const asAgent = await postRounds(world, PUBLIC_ROOM_ID);
    expect(asAgent.status, JSON.stringify(asAgent.body)).toBe(200);
    expect(engineRan(world)).toBe(true);

    actorBoard();
    const asBoard = await postRounds(world, PRIVATE_ROOM_ID);
    expect(asBoard.status, JSON.stringify(asBoard.body)).toBe(200);
    expect(asBoard.body.currentRound).toBe(2);
  });

  it("POST /rooms/:roomId/finalize: agent on a private issue's room gets the missing-issue 404 and the finisher never runs", async () => {
    const world = createApp();
    actorAgent();

    const missing = await postCreate(world, MISSING_ISSUE_ID);
    const notFoundBody = missing.body;

    const priv = await postFinalize(world, PRIVATE_ROOM_ID);
    expect(priv.status).toBe(404);
    expect(priv.body).toEqual(notFoundBody);
    expect(engineRan(world)).toBe(false);
    expect(world.modelCalls).toEqual([]);
  });

  it("POST /rooms/:roomId/finalize: agent on a public room finalizes; board on a private room finalizes", async () => {
    const world = createApp();

    actorAgent();
    const asAgent = await postFinalize(world, PUBLIC_ROOM_ID);
    expect(asAgent.status, JSON.stringify(asAgent.body)).toBe(200);
    expect(asAgent.body.status).toBe("completed");
    expect(engineRan(world)).toBe(true);

    actorBoard();
    const asBoard = await postFinalize(world, PRIVATE_ROOM_ID);
    expect(asBoard.status, JSON.stringify(asBoard.body)).toBe(200);
    expect(asBoard.body.status).toBe("completed");
  });

  it("POST /rooms/:roomId/stop: agent on a private issue's room gets the missing-issue 404 and the stop never runs", async () => {
    const world = createApp();
    actorAgent();

    const missing = await postCreate(world, MISSING_ISSUE_ID);
    const notFoundBody = missing.body;

    const priv = await postStop(world, PRIVATE_ROOM_ID);
    expect(priv.status).toBe(404);
    expect(priv.body).toEqual(notFoundBody);
    expect(engineRan(world)).toBe(false);
  });

  it("POST /rooms/:roomId/stop: agent stops a public room it opened; board stops a private room", async () => {
    const world = createApp();

    actorAgent();
    const opened = await postCreate(world, PUBLIC_ISSUE_ID);
    expect(opened.status).toBe(201);
    const asAgent = await postStop(world, opened.body.id);
    expect(asAgent.status, JSON.stringify(asAgent.body)).toBe(200);
    expect(asAgent.body.status).toBe("stopped");

    actorBoard();
    const asBoard = await postStop(world, PRIVATE_ROOM_ID);
    expect(asBoard.status, JSON.stringify(asBoard.body)).toBe(200);
    expect(asBoard.body.status).toBe("stopped");
  });
});
