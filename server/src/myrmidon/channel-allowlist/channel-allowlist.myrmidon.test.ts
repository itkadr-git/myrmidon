// myrmidon(CA-A): unit coverage for the channel allowlist — the pure
// admission matcher, the handle normalizer, the access-mode resolver, and
// the board routes' HTTP shape with a fake service (no database: the
// domain rules and the full refuse-and-request pipeline run in
// chat-telegram-dm-conversation.myrmidon.test.ts against real postgres).
//
// Neutral data only: synthetic ids, example handles.
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { ChannelAllowedUser } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { channelAllowlistRoutes } from "./routes.js";
import {
  isAdmittedByRows,
  normalizeChannelHandle,
  type ChannelAllowlistService,
} from "./service.js";
import {
  resolveChannelAccessMode,
  CHANNEL_ACCESS_MODE_ENV,
} from "./settings.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ENDPOINT_ID = "44444444-4444-4444-8444-444444444444";
const ROW_ID = "55555555-5555-4555-8555-555555555555";

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
const outsider = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: ["99999999-9999-4999-8999-999999999999"] };
const agentActor = { type: "agent", source: "agent_key", agentId: "11111111-1111-4111-8111-111111111111", companyId: COMPANY_ID, keyId: "key-a" };

function allowedUser(overrides: Partial<ChannelAllowedUser> = {}): ChannelAllowedUser {
  return {
    id: ROW_ID,
    companyId: COMPANY_ID,
    provider: "telegram",
    externalId: "700001",
    handle: "alice",
    displayName: "Alice Example",
    scope: "company",
    endpointId: null,
    boardUserId: null,
    status: "active",
    addedBy: "user-a",
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    ...overrides,
  };
}

function fakeService() {
  const svc = {
    list: vi.fn(async (): Promise<ChannelAllowedUser[]> => [allowedUser()]),
    create: vi.fn(async (): Promise<ChannelAllowedUser> => allowedUser()),
    update: vi.fn(async (): Promise<ChannelAllowedUser> => allowedUser({ status: "revoked" })),
  };
  return { svc };
}

function app(actor: unknown, svc: ChannelAllowlistService = fakeService().svc) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", channelAllowlistRoutes({} as never, svc));
  server.use(errorHandler);
  return server;
}

const BASE = "/api/myrmidon/channel-allowlist";

describe("myrmidon(CA-A) allowlist matching", () => {
  const rows = [
    { provider: "telegram", externalId: "700001", handle: "alice", scope: "company", endpointId: null, status: "active" },
    { provider: "telegram", externalId: "700002", handle: null, scope: "endpoint", endpointId: ENDPOINT_ID, status: "active" },
    { provider: "telegram", externalId: "700003", handle: "carol", scope: "company", endpointId: null, status: "revoked" },
    { provider: "slack", externalId: "U0ALICE", handle: null, scope: "company", endpointId: null, status: "active" },
  ] as const;

  it("normalizes handles: @, case and blanks", () => {
    expect(normalizeChannelHandle("@Alice")).toBe("alice");
    expect(normalizeChannelHandle("  alice  ")).toBe("alice");
    expect(normalizeChannelHandle("")).toBeNull();
    expect(normalizeChannelHandle(null)).toBeNull();
  });

  it("admits by exact provider id", () => {
    expect(
      isAdmittedByRows(rows, { provider: "telegram", externalId: "700001", handle: null, endpointId: "other" }),
    ).toBe(true);
  });

  it("admits by case-insensitive handle when both sides carry one", () => {
    expect(
      isAdmittedByRows(rows, { provider: "telegram", externalId: "999999", handle: "@ALICE", endpointId: "any" }),
    ).toBe(true);
  });

  it("matches an endpoint-scoped row only on that endpoint", () => {
    const atBot = isAdmittedByRows(rows, { provider: "telegram", externalId: "700002", handle: null, endpointId: ENDPOINT_ID });
    const elsewhere = isAdmittedByRows(rows, { provider: "telegram", externalId: "700002", handle: null, endpointId: "other-endpoint" });
    expect(atBot).toBe(true);
    expect(elsewhere).toBe(false);
  });

  it("never admits a revoked row", () => {
    expect(
      isAdmittedByRows(rows, { provider: "telegram", externalId: "700003", handle: null, endpointId: "any" }),
    ).toBe(false);
  });

  it("keeps provider identities separate", () => {
    expect(
      isAdmittedByRows(rows, { provider: "telegram", externalId: "U0ALICE", handle: null, endpointId: "any" }),
    ).toBe(false);
  });
});

describe("myrmidon(CA-A) access mode", () => {
  it("environment wins over the stored document", () => {
    expect(resolveChannelAccessMode("allowlist", "sponsor")).toEqual({ mode: "sponsor", source: "env" });
    expect(resolveChannelAccessMode(null, "allowlist")).toEqual({ mode: "allowlist", source: "env" });
  });

  it("stored document wins over the default", () => {
    expect(resolveChannelAccessMode("allowlist", undefined)).toEqual({ mode: "allowlist", source: "ui" });
  });

  it("a malformed value falls back to the vendor default (never to allowlist)", () => {
    expect(resolveChannelAccessMode("ALLOW LIST", "  ")).toEqual({ mode: "sponsor", source: "default" });
    expect(resolveChannelAccessMode(true, undefined)).toEqual({ mode: "sponsor", source: "default" });
  });

  it("case-insensitive spelling of the two modes", () => {
    expect(process.env[CHANNEL_ACCESS_MODE_ENV]).toBeUndefined();
    expect(resolveChannelAccessMode("AllowList", undefined).mode).toBe("allowlist");
  });
});

describe("myrmidon(CA-A) allowlist routes", () => {
  it("lists for a company member and refuses agents and outsiders", async () => {
    const res = await request(app(member)).get(`${BASE}?companyId=${COMPANY_ID}`).expect(200);
    expect(res.body.allowedUsers).toHaveLength(1);
    await request(app(agentActor)).get(`${BASE}?companyId=${COMPANY_ID}`).expect(403);
    await request(app(outsider)).get(`${BASE}?companyId=${COMPANY_ID}`).expect(403);
  });

  it("requires the company context", async () => {
    const multi = { type: "board", source: "session", userId: "user-c", isInstanceAdmin: false, companyIds: [COMPANY_ID, "55555555-5555-4555-8555-555555555555"] };
    await request(app(multi)).get(BASE).expect(422);
  });

  it("creates with a valid body and rejects malformed admission rows", async () => {
    const { svc } = fakeService();
    const created = await request(app(member, svc as unknown as ChannelAllowlistService))
      .post(BASE)
      .query({ companyId: COMPANY_ID })
      .send({ provider: "telegram", externalId: "700001", handle: "@alice", scope: "company" })
      .expect(201);
    expect(created.body.allowedUser.externalId).toBe("700001");
    expect(svc.create).toHaveBeenCalledTimes(1);

    await request(app(member, svc as unknown as ChannelAllowlistService))
      .post(BASE)
      .query({ companyId: COMPANY_ID })
      .send({ provider: "telegram", externalId: "700001", scope: "endpoint" })
      .expect(400);
    await request(app(member, svc as unknown as ChannelAllowlistService))
      .post(BASE)
      .query({ companyId: COMPANY_ID })
      .send({ provider: "myspace", externalId: "700001" })
      .expect(400);
    await request(app(member, svc as unknown as ChannelAllowlistService))
      .post(BASE)
      .query({ companyId: COMPANY_ID })
      .send({ provider: "telegram", externalId: "" })
      .expect(400);
  });

  it("revokes through PATCH", async () => {
    const { svc } = fakeService();
    const res = await request(app(member, svc as unknown as ChannelAllowlistService))
      .patch(`${BASE}/${ROW_ID}`)
      .query({ companyId: COMPANY_ID })
      .send({ status: "revoked" })
      .expect(200);
    expect(res.body.allowedUser.status).toBe("revoked");
  });
});
