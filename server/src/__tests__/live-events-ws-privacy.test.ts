import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, companies, createDb, issues, type Db } from "@myrmidon/db";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent } from "../services/live-events.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Integration harness (PRIVATE-TASKS E3): a real HTTP listener with the real
// ws upgrade path, a real agent API key row, and a shared in-process live
// event bus. Real socket delivery cannot be faked with fake timers because
// the ws handshake and postgres.js pool run on the platform clock.
interface PrivacyHarness {
  server: Server;
  db: Db;
  companyId: string;
  agentKeyToken: string;
  observedQueries: string[];
  wsUrl(companyQuery: string): string;
  insertIssue(id: string, isPrivate: boolean): Promise<void>;
  close(): Promise<void>;
}

async function createPrivacyHarness(): Promise<PrivacyHarness> {
  const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-events-ws-");
  const observedQueries: string[] = [];
  const db = createDb(tempDb.connectionString, { onQuery: (query) => observedQueries.push(query) });

  const companyId = randomUUID();
  const agentId = randomUUID();
  const agentKeyToken = `pcp_agent_test_${randomUUID()}`;
  const httpServer = createServer();

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;
  const wsBase = `ws://127.0.0.1:${address.port}/api/companies/${companyId}/events/ws`;

  await db.insert(companies).values({ id: companyId, name: "Live Events Ws Co", issuePrefix: "LEW" });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Live Events Agent",
    role: "worker",
    adapterType: "process",
    adapterConfig: {},
  });
  await db.insert(agentApiKeys).values({
    agentId,
    companyId,
    name: "Live Events Key",
    keyHash: hashToken(agentKeyToken),
  });

  return {
    server: httpServer,
    db,
    companyId,
    agentKeyToken,
    observedQueries,
    wsUrl: (companyQuery: string) => (companyQuery.length > 0 ? `${wsBase}?${companyQuery}` : wsBase),
    async insertIssue(id: string, isPrivate: boolean) {
      await db.insert(issues).values({
        id,
        companyId,
        title: isPrivate ? "Private issue" : "Public issue",
        status: "todo",
        isPrivate,
      });
    },
    async close() {
      // Only this test's upgrade lane is registered on this throwaway server.
      httpServer.removeAllListeners("upgrade");
      await db.$client.end();
      await tempDb.cleanup();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function activityPayload(entityId: string, details: Record<string, unknown>) {
  return {
    actorType: "user",
    actorId: "board-user",
    action: "issue.comment.created",
    entityType: "issue",
    entityId,
    details,
  };
}

// Integration tests deliberately exercise the platform clock: the ws
// handshake and the privacy-lookup promise chain resolve on real timers.
async function collectMessages(
  url: string,
  publish: () => void,
  expectedCount = 1,
  timeoutMs = 3000,
): Promise<Array<Record<string, unknown>>> {
  const socket = new WebSocket(url);
  const received: Array<Record<string, unknown>> = [];
  const opened = Promise.withResolvers<void>();
  socket.on("message", (data) => {
    received.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  socket.on("open", () => opened.resolve());
  socket.on("error", (err) => opened.reject(err));
  try {
    await opened.promise;
    publish();
    const deadline = Date.now() + timeoutMs;
    let quietFor = 0;
    while (Date.now() < deadline) {
      if (received.length > expectedCount) break;
      if (received.length === expectedCount) {
        // Keep waiting briefly: late events of a multi-event publish must
        // not be cut off by the first delivery.
        quietFor += 20;
        if (quietFor >= 250) break;
      } else {
        quietFor = 0;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    socket.close();
  }
  return received;
}

describeEmbeddedPostgres("live events agent privacy (PRIVATE-TASKS E3)", () => {
  let harness: PrivacyHarness;

  beforeEach(async () => {
    harness = await createPrivacyHarness();
  }, 60_000);

  afterEach(async () => {
    await harness.close();
  }, 60_000);

  it("hides private-issue activity from the agent socket while the board socket still receives it", async () => {
    setupLiveEventsWebSocketServer(harness.server, harness.db, { deploymentMode: "local_trusted" });
    const privateIssueId = randomUUID();
    const publicIssueId = randomUUID();
    await harness.insertIssue(privateIssueId, true);
    await harness.insertIssue(publicIssueId, false);
    harness.observedQueries.length = 0;

    const boardReceived = await collectMessages(harness.wsUrl(""), () => {
      publishLiveEvent({
        companyId: harness.companyId,
        type: "activity.logged",
        payload: activityPayload(privateIssueId, { identifier: "LEW-P", bodySnippet: "secret" }),
      });
    });
    expect(boardReceived).toHaveLength(1);
    expect((boardReceived[0]!.payload as Record<string, unknown>).entityId).toBe(privateIssueId);

    const agentReceived = await collectMessages(
      harness.wsUrl(`token=${harness.agentKeyToken}`),
      () => {
        publishLiveEvent({
          companyId: harness.companyId,
          type: "activity.logged",
          payload: activityPayload(privateIssueId, { identifier: "LEW-P", bodySnippet: "secret" }),
        });
      },
    );
    expect(agentReceived).toEqual([]);

    const agentPublicReceived = await collectMessages(
      harness.wsUrl(`token=${harness.agentKeyToken}`),
      () => {
        publishLiveEvent({
          companyId: harness.companyId,
          type: "activity.logged",
          payload: activityPayload(publicIssueId, { identifier: "LEW-O", bodySnippet: "visible" }),
        });
      },
    );
    expect(agentPublicReceived).toHaveLength(1);
    expect((agentPublicReceived[0]!.payload as Record<string, unknown>).entityId).toBe(publicIssueId);
  });

  it("drops issue-referencing events with a private payload.issueId for agent sockets", async () => {
    setupLiveEventsWebSocketServer(harness.server, harness.db, { deploymentMode: "local_trusted" });
    const privateIssueId = randomUUID();
    await harness.insertIssue(privateIssueId, true);

    const agentReceived = await collectMessages(
      harness.wsUrl(`token=${harness.agentKeyToken}`),
      () => {
        publishLiveEvent({
          companyId: harness.companyId,
          type: "heartbeat.run.status",
          payload: { issueId: privateIssueId, status: "running" },
        });
      },
    );
    expect(agentReceived).toEqual([]);
  });

  it("keeps non-issue events flowing to agent sockets", async () => {
    setupLiveEventsWebSocketServer(harness.server, harness.db, { deploymentMode: "local_trusted" });

    const agentReceived = await collectMessages(
      harness.wsUrl(`token=${harness.agentKeyToken}`),
      () => {
        publishLiveEvent({
          companyId: harness.companyId,
          type: "agent.status",
          payload: { agentId: randomUUID(), status: "idle" },
        });
        publishLiveEvent({
          companyId: harness.companyId,
          type: "heartbeat.run.status",
          payload: { status: "completed" },
        });
      },
    );
    expect(agentReceived).toHaveLength(2);
  });

  it("does not query the database per event for one issue inside the cache window", async () => {
    setupLiveEventsWebSocketServer(harness.server, harness.db, { deploymentMode: "local_trusted" });
    const publicIssueId = randomUUID();
    await harness.insertIssue(publicIssueId, false);
    // The insert itself logs an issues/is_private INSERT; only lookups
    // after this point count toward the cache assertion.
    harness.observedQueries.length = 0;

    // First delivery pays the lookup; the two follow-ups must be served from
    // the shared cache, so only one issues-related query is observed.
    const received = await collectMessages(
      harness.wsUrl(`token=${harness.agentKeyToken}`),
      () => {
        for (let i = 0; i < 3; i += 1) {
          publishLiveEvent({
            companyId: harness.companyId,
            type: "activity.logged",
            payload: activityPayload(publicIssueId, { seq: i }),
          });
        }
      },
      3,
    );
    expect(received).toHaveLength(3);
    const privacyQueries = harness.observedQueries.filter(
      (query) => query.includes("issues") && query.includes("is_private"),
    );
    expect(privacyQueries).toHaveLength(1);
  });

  it("fails closed: when the privacy lookup rejects the agent socket gets nothing", async () => {
    const publicIssueId = randomUUID();
    await harness.insertIssue(publicIssueId, false);
    // Fail only the privacy SELECT over the issues table: agentApiKeys
    // authorization goes through the same select() but a different table,
    // so the ws upgrade path keeps working.
    const privacyDb = new Proxy(harness.db, {
      get(target, prop) {
        if (prop !== "select") return Reflect.get(target, prop);
        return (...selectArgs: unknown[]) => {
          const builder = Reflect.get(target, "select").apply(target, selectArgs);
          const realFrom = builder.from.bind(builder);
          builder.from = (table: unknown) => {
            if (table === issues) throw new Error("privacy lookup unavailable");
            return realFrom(table);
          };
          return builder;
        };
      },
    }) as unknown as Db;
    setupLiveEventsWebSocketServer(harness.server, privacyDb, {
      deploymentMode: "local_trusted",
    });
    vi.mocked(logger.warn).mockClear();

    const agentReceived = await collectMessages(
      harness.wsUrl(`token=${harness.agentKeyToken}`),
      () => {
        publishLiveEvent({
          companyId: harness.companyId,
          type: "activity.logged",
          payload: activityPayload(publicIssueId, { identifier: "LEW-F" }),
        });
      },
    );
    expect(agentReceived).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: harness.companyId, eventId: expect.any(Number) }),
      "agent live-events privacy lookup failed; dropping event",
    );
  });
});
