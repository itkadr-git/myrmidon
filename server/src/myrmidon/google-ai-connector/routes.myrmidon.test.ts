// myrmidon(GOOGLE-AI-CONNECT-UI): route tests — plain fakes, no database.
//
// Covers the authorization contract (401 unauthenticated, 403 for an agent on
// the configuration surface, membership + owner role for board users), the
// write-only connect path (the cookie value never leaves in a response), the
// grant-checked agent call, the trial guard before a connection exists, and
// the bridge-facing session delivery (mode gate, bearer token, bundle shape).

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { googleAiConnectorRoutes } from "./routes.js";
import { googleAiConnectorService, type GoogleAiConnectorService } from "./service.js";
import {
  memoryGoogleAiConnectorStore,
  type GoogleAiConnectorDocument,
} from "./store.js";
import { memoryGaiSessionStore } from "./session-store.js";
import type { GaiBridgeClient, GaiBridgeOutcome } from "./bridge.js";
import type { GaiDeliveryMode, GaiHealth } from "@paperclipai/shared/myrmidon-google-ai-connector";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PASTE = JSON.stringify([
  { name: "NID", value: "noise" },
  { name: "__Secure-1PSID", value: "COOKIE-VALUE-LEAK-CANARY" },
  { name: "__Secure-1PSIDTS", value: "TS-VALUE-LEAK-CANARY" },
]);

const owner = {
  type: "board",
  source: "session",
  userId: "user-owner",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "owner" }],
};
const member = {
  type: "board",
  source: "session",
  userId: "user-member",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "member" }],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
};

interface Harness {
  routes: ReturnType<typeof googleAiConnectorRoutes>;
  service: GoogleAiConnectorService;
  session: ReturnType<typeof memoryGaiSessionStore>;
  store: GoogleAiConnectorDocument;
  bridge: { health: GaiHealth | null; outcomes: GaiBridgeOutcome[] };
}

function buildHarness(
  options: {
    deliveryMode?: GaiDeliveryMode;
    grants?: GoogleAiConnectorDocument["grants"];
    agentRole?: string | null;
  } = {},
): Harness {
  const store = memoryGoogleAiConnectorStore({
    version: 1,
    connections: [],
    grants: options.grants ?? [],
    journal: [],
  });
  const session = memoryGaiSessionStore();
  const bridge = {
    health: {
      session: "ok",
      quota: { images: { used: 1, limit: 100 }, videos: { used: 0, limit: 10 }, paused: false, pausedUntil: null },
      version: "1.0.0",
    } as GaiHealth,
    outcomes: [] as GaiBridgeOutcome[],
  };
  const fakeBridge: GaiBridgeClient = {
    async generate() {
      const next = bridge.outcomes.shift() ?? { ok: true, kind: "sync", text: null, imagePaths: ["/gen/trial.png"] };
      return next;
    },
    async job() {
      return { job: null };
    },
    async health() {
      return bridge.health;
    },
  };
  const service = googleAiConnectorService({
    store,
    session,
    bridge: fakeBridge,
    agentRole: async () => options.agentRole ?? null,
    deliveryMode: options.deliveryMode ?? "endpoint",
  });
  const harness: Harness = {
    routes: googleAiConnectorRoutes({ service, session, bridgeDeliveryToken: () => "delivery-token" }),
    service,
    session,
    store: store as unknown as GoogleAiConnectorDocument,
    bridge,
  };
  return harness;
}

function app(actor: unknown, harness: Harness) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", harness.routes);
  server.use(errorHandler);
  return server;
}

const query = `?companyId=${COMPANY_ID}`;

async function connectOwner(harness: Harness) {
  return request(app(owner, harness))
    .post("/api/myrmidon/google-ai-connector/connect")
    .send({ companyId: COMPANY_ID, cookieJson: PASTE });
}

describe("google-ai-connector routes", () => {
  it("refuses unauthenticated and agent callers on the owner surface", async () => {
    const harness = buildHarness();
    const anonymous = { type: "none" };
    expect((await request(app(anonymous, harness)).get(`/api/myrmidon/google-ai-connector/state${query}`)).status).toBe(401);
    const agentOnConfig = await request(app(agentActor, harness)).put("/api/myrmidon/google-ai-connector/grants").send({
      companyId: COMPANY_ID,
      capability: "generate_image",
      targetKind: "all",
    });
    expect(agentOnConfig.status).toBe(403);
  });

  it("refuses a board member who is not the company owner", async () => {
    const harness = buildHarness();
    const res = await request(app(member, harness)).get(`/api/myrmidon/google-ai-connector/state${query}`);
    expect(res.status).toBe(403);
  });

  it("connects the owner: secret id on the connection, no cookie value anywhere in the response", async () => {
    const harness = buildHarness();
    const res = await connectOwner(harness);
    expect(res.status).toBe(200);
    expect(res.body.connection.status).toBe("connected");
    expect(res.body.connection.secretId).toBe("gai-secret-1");
    expect(res.body.keptCookies).toEqual(["__Secure-1PSID", "__Secure-1PSIDTS"]);
    expect(res.body.ignoredCookies).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain("COOKIE-VALUE-LEAK-CANARY");
    expect(JSON.stringify(res.body)).not.toContain("TS-VALUE-LEAK-CANARY");
  });

  it("reconnect rotates the same secret instead of writing a second one", async () => {
    const harness = buildHarness();
    const first = await connectOwner(harness);
    const second = await request(app(owner, harness))
      .post("/api/myrmidon/google-ai-connector/reconnect")
      .send({ companyId: COMPANY_ID, cookieJson: PASTE });
    expect(second.status).toBe(200);
    expect(second.body.connection.secretId).toBe(first.body.connection.secretId);
    const stored = await harness.session.read(COMPANY_ID, first.body.connection.secretId);
    expect(stored?.version).toBe(2);
  });

  it("refuses a broken paste with a readable message and no value echo", async () => {
    const harness = buildHarness();
    const res = await request(app(owner, harness))
      .post("/api/myrmidon/google-ai-connector/connect")
      .send({ companyId: COMPANY_ID, cookieJson: JSON.stringify([{ name: "__Secure-1PSID", value: "COOKIE-VALUE-LEAK-CANARY" }]) });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("COOKIE-VALUE-LEAK-CANARY");
  });

  it("grants, call with the grant, and refusal with journal entry without it", async () => {
    const harness = buildHarness();
    const put = await request(app(owner, harness)).put("/api/myrmidon/google-ai-connector/grants").send({
      companyId: COMPANY_ID,
      capability: "generate_image",
      targetKind: "agent",
      agentId: AGENT_ID,
    });
    expect(put.status).toBe(200);
    const agentApp = app(agentActor, harness);
    const allowed = await request(agentApp).post("/api/myrmidon/google-ai-connector/call").send({ kind: "image", prompt: "lighthouse" });
    expect(allowed.status).toBe(200);
    expect(allowed.body.ok).toBe(true);
    expect(allowed.body.imagePaths).toEqual(["/gen/trial.png"]);
    const denied = await request(agentApp).post("/api/myrmidon/google-ai-connector/call").send({ kind: "text", prompt: "sonnet" });
    expect(denied.status).toBe(403);
    const journal = await request(app(owner, harness)).get(`/api/myrmidon/google-ai-connector/journal${query}`);
    expect(journal.status).toBe(200);
    const refusals = journal.body.entries.filter((entry: { ok: boolean }) => !entry.ok);
    expect(refusals.map((entry: { detail: string }) => entry.detail)).toContain("no grant for creative_text");
  });

  it("a caste grant covers every agent of that caste", async () => {
    const harness = buildHarness({
      agentRole: "writer",
      grants: [
        {
          id: "grant-caste",
          companyId: COMPANY_ID,
          capability: "creative_text",
          targetKind: "caste",
          agentId: null,
          caste: "writer",
          createdAt: "2026-01-01T00:00:00.000Z",
          createdBy: "user-owner",
        },
      ],
    });
    const res = await request(app(agentActor, harness)).post("/api/myrmidon/google-ai-connector/call").send({ kind: "text", prompt: "haiku" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("video is never granted while the board ships the capability disabled", async () => {
    const harness = buildHarness({
      grants: [
        {
          id: "grant-video",
          companyId: COMPANY_ID,
          capability: "generate_video",
          targetKind: "all",
          agentId: null,
          caste: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          createdBy: "user-owner",
        },
      ],
    });
    const res = await request(app(agentActor, harness)).post("/api/myrmidon/google-ai-connector/call").send({ kind: "video", prompt: "trailer" });
    expect(res.status).toBe(403);
    expect(res.body.error ?? JSON.stringify(res.body)).toContain("generate_video");
  });

  it("trial refuses before a connection exists and runs as owner afterwards", async () => {
    const harness = buildHarness();
    const before = await request(app(owner, harness)).post("/api/myrmidon/google-ai-connector/trial").send({ companyId: COMPANY_ID });
    expect(before.status).toBe(409);
    await connectOwner(harness);
    const after = await request(app(owner, harness)).post("/api/myrmidon/google-ai-connector/trial").send({ companyId: COMPANY_ID });
    expect(after.status).toBe(200);
    expect(after.body.ok).toBe(true);
  });

  it("check reports stale as expired and flips the connection status", async () => {
    const harness = buildHarness();
    await connectOwner(harness);
    harness.bridge.health = { ...harness.bridge.health!, session: "stale" };
    const res = await request(app(owner, harness)).post(`/api/myrmidon/google-ai-connector/check${query}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("stale");
    expect(res.body.staleNow).toBe(true);
    const state = await request(app(owner, harness)).get(`/api/myrmidon/google-ai-connector/state${query}`);
    expect(state.body.connection.status).toBe("stale");
  });

  it("session delivery: off mode hides the route, the token gates it, and the bundle shape is the frozen one", async () => {
    const hidden = buildHarness({ deliveryMode: "off" });
    const off = await request(app(owner, hidden)).get("/api/myrmidon/google-ai-connector/session");
    expect(off.status).toBe(404);

    const harness = buildHarness();
    const badToken = await request(app(owner, harness))
      .get("/api/myrmidon/google-ai-connector/session")
      .set("authorization", "Bearer wrong");
    expect(badToken.status).toBe(401);

    await connectOwner(harness);
    const served = await request(app({ type: "none" }, harness))
      .get(`/api/myrmidon/google-ai-connector/session${query}`)
      .set("authorization", "Bearer delivery-token");
    expect(served.status).toBe(200);
    expect(served.body).toEqual([
      { name: "__Secure-1PSID", value: "COOKIE-VALUE-LEAK-CANARY" },
      { name: "__Secure-1PSIDTS", value: "TS-VALUE-LEAK-CANARY" },
    ]);
  });

  it("jobs of the bridge answer 404 for owner and stay company-confined for agents", async () => {
    const harness = buildHarness();
    const ownerRes = await request(app(owner, harness)).get(`/api/myrmidon/google-ai-connector/jobs/job-1${query}`);
    expect(ownerRes.status).toBe(404);
    const agentRes = await request(app({ ...agentActor, companyId: null }, harness)).get("/api/myrmidon/google-ai-connector/jobs/job-1");
    expect(agentRes.status).toBe(403);
  });
});
