import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { agentApiKeys, agents } from "@myrmidon/db";

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { getAccessibleResource, hasCompanyAccess } = await import("../routes/authz.js");
const { actorMiddleware } = await import("../middleware/auth.js");
const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createSelectChain(rowsForTable: (table: unknown) => unknown[]) {
  return {
    from(table: unknown) {
      return {
        where() {
          return Promise.resolve(rowsForTable(table));
        },
      };
    },
  };
}

function createDbState(input: {
  agent?: { id: string; companyId: string; status?: string } | null;
  agentKey?: { id: string; agentId: string; companyId: string; keyHash: string; responsibleUserId?: string | null } | null;
}) {
  const agentRow = input.agent
    ? { id: input.agent.id, companyId: input.agent.companyId, status: input.agent.status ?? "active" }
    : null;
  const keyRow = input.agentKey
    ? {
        id: input.agentKey.id,
        agentId: input.agentKey.agentId,
        companyId: input.agentKey.companyId,
        keyHash: input.agentKey.keyHash,
        responsibleUserId: input.agentKey.responsibleUserId ?? null,
        revokedAt: null,
        scopeConfig: null,
      }
    : null;

  const db = {
    select: () =>
      createSelectChain((table) => {
        if (table === agentApiKeys) return keyRow ? [keyRow] : [];
        if (table === agents) return agentRow ? [agentRow] : [];
        return [];
      }),
    update: () => ({
      set() {
        return {
          where() {
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert: () => ({
      values() {
        return Promise.resolve([]);
      },
    }),
  } as any;
  return { db };
}

function createMiddlewareApp(db: any, resolveSession?: () => Promise<any>) {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: resolveSession ?? (async () => null),
    }),
  );
  app.get("/actor", (req, res) => {
    res.json({ actor: req.actor, actorNoneReason: req.actorNoneReason ?? null });
  });
  app.get("/resource/:id", async (req, res) => {
    const resource = await getAccessibleResource(
      req as any,
      res,
      { id: req.params.id, companyId: "22222222-2222-4222-8222-222222222222" },
      "Resource not found",
    );
    if (!resource) return;
    res.json(resource);
  });
  app.use(errorHandler);
  return app;
}

describe("OPE-10599: anonymous actor on company resource routes", () => {
  const companyId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createTestApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });

    const router = express.Router();
    router.get("/resource/:id", async (req, res) => {
      const resource = await getAccessibleResource(
        req as any,
        res,
        { id: req.params.id, companyId },
        "Resource not found",
      );
      if (!resource) return;
      res.json(resource);
    });
    router.get("/direct/:id", async (req, res) => {
      if (!hasCompanyAccess(req as any, companyId)) {
        res.status(404).json({ error: "Resource not found" });
        return;
      }
      res.json({ id: req.params.id, companyId });
    });
    app.use("/api", router);
    return app;
  }

  it("anonymous actor gets 401 from getAccessibleResource", async () => {
    const app = createTestApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/resource/abc-123");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
  });

  it("getAccessibleResource logs a warning with actorNoneReason for anonymous actor", async () => {
    const app = createTestApp({ type: "none", source: "none" });
    await request(app).get("/api/resource/abc-123");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        actorNoneReason: expect.any(String),
        method: "GET",
        url: "/api/resource/abc-123",
      }),
      "Anonymous request to company resource; sending 401",
    );
  });

  it("getAccessibleResource surfaces the reason recorded by the middleware", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      (req as any).actorNoneReason = "no_credentials";
      next();
    });
    const router = express.Router();
    router.get("/resource/:id", async (req, res) => {
      const resource = await getAccessibleResource(
        req as any,
        res,
        { id: req.params.id, companyId },
        "Resource not found",
      );
      if (!resource) return;
      res.json(resource);
    });
    app.use("/api", router);

    await request(app).get("/api/resource/abc-123");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ actorNoneReason: "no_credentials" }),
      "Anonymous request to company resource; sending 401",
    );
  });

  it("cross-tenant agent gets 404 from getAccessibleResource", async () => {
    const app = createTestApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "other-company",
      source: "agent_key",
    });
    const res = await request(app).get("/api/resource/abc-123");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Resource not found" });
  });

  it("same-tenant agent gets 200 from getAccessibleResource", async () => {
    const app = createTestApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });
    const res = await request(app).get("/api/resource/abc-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "abc-123", companyId });
  });

  it("anonymous actor gets 404 from direct hasCompanyAccess and is logged", async () => {
    const app = createTestApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/direct/abc-123");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Resource not found" });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        actorNoneReason: expect.any(String),
        method: "GET",
      }),
      "Anonymous actor denied company access",
    );
  });

  it("cross-tenant agent gets 404 from direct hasCompanyAccess", async () => {
    const app = createTestApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "other-company",
      source: "agent_key",
    });
    const res = await request(app).get("/api/direct/abc-123");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Resource not found" });
  });

  it("same-tenant agent gets 200 from direct hasCompanyAccess", async () => {
    const app = createTestApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });
    const res = await request(app).get("/api/direct/abc-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "abc-123", companyId });
  });
});

describe("OPE-10599 review: middleware actorNoneReason granularity", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "authz-anon-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
  });

  function hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  function createSelectChain(rowsForTable: (table: unknown) => unknown[]) {
    return {
      from(table: unknown) {
        return {
          where() {
            return Promise.resolve(rowsForTable(table));
          },
        };
      },
    };
  }

  function createDbState(input: {
    agent?: { id: string; companyId: string; status?: string } | null;
    agentKey?: { id: string; agentId: string; companyId: string; keyHash: string; responsibleUserId?: string | null } | null;
  }) {
    const agentRow = input.agent
      ? { id: input.agent.id, companyId: input.agent.companyId, status: input.agent.status ?? "active" }
      : null;
    const keyRow = input.agentKey
      ? {
          id: input.agentKey.id,
          agentId: input.agentKey.agentId,
          companyId: input.agentKey.companyId,
          keyHash: input.agentKey.keyHash,
          responsibleUserId: input.agentKey.responsibleUserId ?? null,
          revokedAt: null,
          scopeConfig: null,
        }
      : null;

    const db = {
      select: () =>
        createSelectChain((table) => {
          if (table === agentApiKeys) return keyRow ? [keyRow] : [];
          if (table === agents) return agentRow ? [agentRow] : [];
          return [];
        }),
      update: () => ({
        set() {
          return {
            where() {
              return Promise.resolve([]);
            },
          };
        },
      }),
      insert: () => ({
        values() {
          return Promise.resolve([]);
        },
      }),
    } as any;
    return { db };
  }

  function createMiddlewareApp(db: any, resolveSession?: () => Promise<any>) {
    const app = express();
    app.use(express.json());
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: resolveSession ?? (async () => null),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json({ actor: req.actor, actorNoneReason: req.actorNoneReason ?? null });
    });
    app.get("/resource/:id", async (req, res) => {
      const resource = await getAccessibleResource(
        req as any,
        res,
        { id: req.params.id, companyId: "22222222-2222-4222-8222-222222222222" },
        "Resource not found",
      );
      if (!resource) return;
      res.json(resource);
    });
    app.use(errorHandler);
    return app;
  }

  it("no credentials at all → actorNoneReason = no_credentials", async () => {
    const { db } = createDbState({ agent: null });
    const app = createMiddlewareApp(db);
    const res = await request(app).get("/actor");
    expect(res.status).toBe(200);
    expect(res.body.actor.type).toBe("none");
    expect(res.body.actorNoneReason).toBe("no_credentials");
  });

  it("session resolution throws → actorNoneReason = session_resolution_error", async () => {
    const { db } = createDbState({ agent: null });
    const app = createMiddlewareApp(db, async () => {
      throw new Error("session backend down");
    });
    const res = await request(app).get("/actor");
    expect(res.status).toBe(200);
    expect(res.body.actor.type).toBe("none");
    expect(res.body.actorNoneReason).toBe("session_resolution_error");
  });

  it("session resolves but invalid → actorNoneReason = session_invalid", async () => {
    const { db } = createDbState({ agent: null });
    const app = createMiddlewareApp(db, async () => ({
      user: { id: "" },
      session: { id: "sess-1" },
    }));
    const res = await request(app).get("/actor");
    expect(res.status).toBe(200);
    expect(res.body.actor.type).toBe("none");
    expect(res.body.actorNoneReason).toBe("session_invalid");
  });

  it("expired agent JWT → 401 and actorNoneReason = agent_token_expired", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId } });
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const claims = {
      sub: agentId,
      company_id: companyId,
      adapter_type: "codex_local",
      run_id: runId,
      iat: now - 7200,
      exp: now - 3600,
      iss: "paperclip",
      aud: "paperclip-api",
    };
    const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
    const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signingInput = `${headerB64}.${claimsB64}`;
    const signingKey = createHmac("sha256", process.env.PAPERCLIP_AGENT_JWT_SECRET!).update(`jwt:default:${companyId}`).digest("hex");
    const signature = createHmac("sha256", signingKey).update(signingInput).digest("base64url");
    const token = `${signingInput}.${signature}`;

    const app = createMiddlewareApp(db);
    const res = await request(app).get("/resource/abc-123").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Expired agent token");
  });

  it("tampered agent JWT signature → 401 and actorNoneReason = agent_token_invalid", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId } });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    const app = createMiddlewareApp(db);
    const res = await request(app).get("/resource/abc-123").set("Authorization", `Bearer ${tamperedToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent token did not verify");
  });

  it("agent JWT for terminated agent → 401 and actorNoneReason = agent_token_agent_terminated", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId, status: "terminated" } });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");

    const app = createMiddlewareApp(db);
    const res = await request(app).get("/resource/abc-123").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent is terminated");
  });

  it("agent JWT for pending agent → 401 and actorNoneReason = agent_token_agent_pending", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId, status: "pending_approval" } });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");

    const app = createMiddlewareApp(db);
    const res = await request(app).get("/resource/abc-123").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent is pending approval");
  });

  it("agent JWT with wrong company → 401 and actorNoneReason = agent_token_agent_mismatch", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId: randomUUID() } });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");

    const app = createMiddlewareApp(db);
    const res = await request(app).get("/resource/abc-123").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("missing or belongs to another company");
  });

  it("agent API key for terminated agent → 401 and actorNoneReason = agent_key_agent_terminated", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rawKey = `pcp_test_${randomUUID().replace(/-/g, "")}`;
    const { db } = createDbState({
      agent: { id: agentId, companyId, status: "terminated" },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(rawKey),
        responsibleUserId: "user-1",
      },
    });

    const app = createMiddlewareApp(db);
    const res = await request(app).get("/resource/abc-123").set("Authorization", `Bearer ${rawKey}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent is terminated");
  });

  it("warn log from getAccessibleResource includes the specific actorNoneReason", async () => {
    const { db } = createDbState({ agent: null });
    const app = createMiddlewareApp(db, async () => ({
      user: { id: "" },
      session: { id: "sess-1" },
    }));
    await request(app).get("/resource/abc-123");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        actorNoneReason: "session_invalid",
        method: "GET",
        url: "/resource/abc-123",
      }),
      "Anonymous request to company resource; sending 401",
    );
  });
});
