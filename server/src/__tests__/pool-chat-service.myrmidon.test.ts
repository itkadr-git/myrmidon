// myrmidon(1.6.6 POOL-CHAT): service, quota ledger, routes and authorization
// of the pool-chat boundary against embedded Postgres. The transport is a fake:
// no live provider is called.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  poolChatModuleInstances,
  poolChatQuotaReservations,
  poolChatRequestAttempts,
  poolChatRequests,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { poolChatRoutes } from "../myrmidon/pool-chat/routes.js";
import { estimateReservationUnits, poolChatService } from "../myrmidon/pool-chat/service.js";
import type { PoolChatTransport } from "../myrmidon/pool-chat/transports.js";

type Db = ReturnType<typeof useEmbeddedPostgres>["db"];

const okTransport = (): PoolChatTransport => ({
  provider: "chatgpt",
  send: vi.fn(async () => ({ text: "answer", inputUnits: 10, outputUnits: 5, providerRequestRef: null })),
});

function body(over: Record<string, unknown> = {}) {
  return {
    conversationId: "conv-1",
    clientMessageId: "msg-1",
    model: "balanced",
    messages: [{ role: "user" as const, content: "hello there" }],
    maxOutputTokens: 100,
    ...over,
  };
}

const TEST_IDEMPOTENCY_KEY = "idem-test-0001";

async function seed(db: Db, accounts: unknown[]) {
  const companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: `PC ${companyId}`, issuePrefix: `P${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}` });
  const [module] = await db.insert(poolChatModuleInstances).values({
    companyId,
    moduleKey: `chat-${companyId}`,
    provider: "chatgpt",
    config: { allowedModels: ["balanced"], accounts },
    credentialSecretName: "pool-secret",
  }).returning();
  return { companyId, moduleId: module!.id };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const account = (over: Record<string, unknown> = {}) => ({
  accountRef: "pool-acc-1", provider: "chatgpt", enabled: true, quotaUnits: null, usedUnits: 0, ...over,
});

describeEmbeddedPostgres("pool-chat service (embedded PG)", () => {
  const pg = useEmbeddedPostgres("pool-chat-service");

  function submit(svc: ReturnType<typeof poolChatService>, s: { companyId: string; moduleId: string }, over: Record<string, unknown> = {}, key = TEST_IDEMPOTENCY_KEY) {
    return svc.submit({ companyId: s.companyId, moduleId: s.moduleId, channel: "tg", subjectId: "u1", idempotencyKey: key, body: body(over) });
  }

  it("settles a request and replays it without a second upstream send", async () => {
    const s = await seed(pg.db, [account()]);
    const transport = okTransport();
    const svc = poolChatService(pg.db, () => transport);
    const first = await submit(svc, s);
    expect(first.status).toBe("completed");
    const replay = await submit(svc, s);
    expect(replay.id).toBe(first.id);
    expect(transport.send).toHaveBeenCalledTimes(1);
    const [reservation] = await pg.db.select().from(poolChatQuotaReservations).where(eq(poolChatQuotaReservations.requestId, first.id));
    expect(reservation).toMatchObject({ state: "settled", settledUnits: 15 });
  });

  it("rejects a reused idempotency key or client message with a different body", async () => {
    const s = await seed(pg.db, [account()]);
    const svc = poolChatService(pg.db, () => okTransport());
    await submit(svc, s);
    await expect(submit(svc, s, { messages: [{ role: "user", content: "other" }] })).rejects.toMatchObject({ status: 409 });
    await expect(submit(svc, s, { messages: [{ role: "user", content: "other" }] }, "idempotency-key-0002")).rejects.toMatchObject({ status: 409 });
  });

  it("sends once when the same request is submitted concurrently", async () => {
    const s = await seed(pg.db, [account()]);
    const transport = okTransport();
    const svc = poolChatService(pg.db, () => transport);
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(svc, s)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(await pg.db.select().from(poolChatRequests).where(eq(poolChatRequests.moduleId, s.moduleId))).toHaveLength(1);
  });

  it("enforces the account quota atomically across concurrent distinct requests", async () => {
    const units = estimateReservationUnits(body() as never);
    // Room for exactly two reservations.
    const s = await seed(pg.db, [account({ quotaUnits: units * 2 })]);
    const transport: PoolChatTransport = { provider: "chatgpt", send: vi.fn(async () => { await new Promise((r) => setTimeout(r, 400)); return { text: "a", inputUnits: 1, outputUnits: 1, providerRequestRef: null }; }) };
    const svc = poolChatService(pg.db, () => transport);
    const settled = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => submit(svc, s, { clientMessageId: `m-${i}` }, `idempotency-key-${i}0000`)));
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(3);
    for (const r of rejected) expect(r.reason).toMatchObject({ status: 429 });
    expect(transport.send).toHaveBeenCalledTimes(2);
    // Rejected requests leave no ledger rows behind.
    expect(await pg.db.select().from(poolChatRequests).where(eq(poolChatRequests.moduleId, s.moduleId))).toHaveLength(2);
  });

  it("counts settled usage and the configured baseline, and falls over to another account", async () => {
    const s = await seed(pg.db, [account({ quotaUnits: 1000, usedUnits: 990 }), account({ accountRef: "pool-acc-2", quotaUnits: 5000 })]);
    const svc = poolChatService(pg.db, () => okTransport());
    const first = await submit(svc, s);
    const [attempt] = await pg.db.select().from(poolChatRequestAttempts).where(eq(poolChatRequestAttempts.requestId, first.id));
    expect(attempt?.accountRef).toBe("pool-acc-2");
  });

  it("keeps an uncertain send reserved and never retries it", async () => {
    const s = await seed(pg.db, [account({ quotaUnits: 100000 })]);
    const transport: PoolChatTransport = { provider: "chatgpt", send: vi.fn(async () => { throw new Error("socket api_key=secret"); }) };
    const svc = poolChatService(pg.db, () => transport);
    await expect(submit(svc, s)).rejects.toMatchObject({ status: 502 });
    const replay = await submit(svc, s);
    expect(replay.status).toBe("uncertain");
    expect(transport.send).toHaveBeenCalledTimes(1);
    const [attempt] = await pg.db.select().from(poolChatRequestAttempts).where(eq(poolChatRequestAttempts.requestId, replay.id));
    expect(attempt).toMatchObject({ state: "uncertain", failureDetail: "provider_transport_failed" });
    expect(JSON.stringify(attempt)).not.toContain("secret");
    const [reservation] = await pg.db.select().from(poolChatQuotaReservations).where(eq(poolChatQuotaReservations.requestId, replay.id));
    expect(reservation?.state).toBe("reserved");
  });

  it("releases the reservation when no transport can be resolved", async () => {
    const s = await seed(pg.db, [account({ quotaUnits: 100000 })]);
    const svc = poolChatService(pg.db, () => null);
    await expect(submit(svc, s)).rejects.toMatchObject({ status: 503 });
    const [row] = await pg.db.select().from(poolChatRequests).where(eq(poolChatRequests.moduleId, s.moduleId));
    expect(row).toMatchObject({ status: "failed", charged: false });
    const [reservation] = await pg.db.select().from(poolChatQuotaReservations).where(eq(poolChatQuotaReservations.requestId, row!.id));
    expect(reservation?.state).toBe("released");
  });

  it("isolates modules and subjects", async () => {
    const a = await seed(pg.db, [account()]);
    const b = await seed(pg.db, [account()]);
    const svc = poolChatService(pg.db, () => okTransport());
    const ra = await submit(svc, a);
    await expect(svc.status(b.companyId, b.moduleId, ra.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.status(a.companyId, b.moduleId, ra.id)).rejects.toMatchObject({ status: 404 });
    const other = await svc.submit({ companyId: a.companyId, moduleId: a.moduleId, channel: "tg", subjectId: "u2", idempotencyKey: TEST_IDEMPOTENCY_KEY, body: body() });
    expect(other.id).not.toBe(ra.id);
  });
});

describeEmbeddedPostgres("pool-chat routes and authorization (embedded PG)", () => {
  const pg = useEmbeddedPostgres("pool-chat-routes");

  function app(actor: Record<string, unknown>, transport = okTransport()) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { (req as any).actor = actor; next(); });
    server.use("/api", poolChatRoutes(pg.db, () => transport));
    server.use(errorHandler);
    return server;
  }

  async function principal(companyId: string, scope: Record<string, unknown> | null, id = `svc-${randomUUID()}`) {
    await pg.db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole: "member" });
    if (scope !== undefined) {
      await pg.db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: id, permissionKey: "chat:invoke", scope });
    }
    return { type: "board", source: "board_key", userId: id, companyIds: [companyId], memberships: [], isInstanceAdmin: false };
  }

  const base = (s: { companyId: string; moduleId: string }) => `/api/companies/${s.companyId}/modules/${s.moduleId}/chat`;

  it("allows only the exact module/channel/subject tuple granted", async () => {
    const s = await seed(pg.db, [account()]);
    const actor = await principal(s.companyId, { moduleId: s.moduleId, channelId: "tg", subjectId: "u1" });
    const ok = await request(app(actor)).post(`${base(s)}/requests`).set("Idempotency-Key", TEST_IDEMPOTENCY_KEY).query({ channelId: "tg", subjectId: "u1" }).send(body());
    expect(ok.status).toBe(201);
    expect(ok.body.request.status).toBe("completed");
    for (const wrong of [{ channelId: "other", subjectId: "u1" }, { channelId: "tg", subjectId: "u2" }, {}]) {
      const res = await request(app(actor)).post(`${base(s)}/requests`).set("Idempotency-Key", "idempotency-key-9999").query(wrong).send(body());
      expect(res.status).toBe(403);
    }
  });

  it("keeps the identity tuple out of the body and validates it in the query", async () => {
    const s = await seed(pg.db, [account()]);
    const actor = await principal(s.companyId, { moduleId: s.moduleId, channelId: "tg", subjectId: "u1" });
    const inBody = await request(app(actor)).post(`${base(s)}/requests`).set("Idempotency-Key", TEST_IDEMPOTENCY_KEY).query({ channelId: "tg", subjectId: "u1" }).send({ ...body(), channelId: "tg", subjectId: "u1" });
    expect(inBody.status).toBe(400);
    const malformed = await request(app(actor)).post(`${base(s)}/requests`).set("Idempotency-Key", TEST_IDEMPOTENCY_KEY).query({ channelId: "tg bad", subjectId: "u1" }).send(body());
    expect(malformed.status).toBe(400);
    expect(await pg.db.select().from(poolChatRequests).where(eq(poolChatRequests.companyId, s.companyId))).toHaveLength(0);
  });

  it("denies a missing grant, a grant for another module, an unscoped grant and non-member callers", async () => {
    const s = await seed(pg.db, [account()]);
    const other = await seed(pg.db, [account()]);
    const send = (actor: Record<string, unknown>) => request(app(actor)).get(`${base(s)}/capabilities`).query({ channelId: "tg", subjectId: "u1" });
    expect((await send(await principal(s.companyId, undefined as never))).status).toBe(403);
    expect((await send(await principal(s.companyId, { moduleId: other.moduleId, channelId: "tg", subjectId: "u1" }))).status).toBe(403);
    expect((await send(await principal(s.companyId, null))).status).toBe(403);
    expect((await send(await principal(s.companyId, { moduleId: s.moduleId, channelId: "tg" }))).status).toBe(403);
    expect((await send({ type: "board", source: "session", userId: "stranger", companyIds: [], memberships: [], isInstanceAdmin: false })).status).toBe(403);
    const granted = await send(await principal(s.companyId, { moduleId: s.moduleId, channelId: "tg", subjectId: "u1" }));
    expect(granted.status).toBe(200);
    expect(JSON.stringify(granted.body)).not.toContain("pool-acc");
  });

  it("rejects agent callers without a scoped key and bad idempotency keys", async () => {
    const s = await seed(pg.db, [account()]);
    const jwtAgent = { type: "agent", source: "agent_jwt", agentId: "agent-1", companyId: s.companyId };
    expect((await request(app(jwtAgent)).get(`${base(s)}/capabilities`)).status).toBe(403);
    const actor = await principal(s.companyId, { moduleId: s.moduleId, channelId: "tg", subjectId: "u1" });
    const bad = await request(app(actor)).post(`${base(s)}/requests`).set("Idempotency-Key", "short").query({ channelId: "tg", subjectId: "u1" }).send(body());
    expect(bad.status).toBe(400);
  });

  it("authorizes status reads against the persisted request scope", async () => {
    const s = await seed(pg.db, [account()]);
    const owner = await principal(s.companyId, { moduleId: s.moduleId, channelId: "tg", subjectId: "u1" });
    const created = await request(app(owner)).post(`${base(s)}/requests`).set("Idempotency-Key", TEST_IDEMPOTENCY_KEY).query({ channelId: "tg", subjectId: "u1" }).send(body());
    const id = created.body.request.id as string;
    expect((await request(app(owner)).get(`${base(s)}/requests/${id}`).query({ channelId: "tg", subjectId: "u1" })).status).toBe(200);
    const stranger = await principal(s.companyId, { moduleId: s.moduleId, channelId: "tg", subjectId: "u2" });
    expect((await request(app(stranger)).get(`${base(s)}/requests/${id}`)).status).toBe(403);
    expect((await request(app(owner)).get(`${base(s)}/requests/${randomUUID()}`)).status).toBe(404);
  });
});
