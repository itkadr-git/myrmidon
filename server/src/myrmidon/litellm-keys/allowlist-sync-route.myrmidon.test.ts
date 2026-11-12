// server/src/myrmidon/litellm-keys/allowlist-sync-route.myrmidon.test.ts
//
// myrmidon(1.6.7 OPE-12345): POST …/litellm/keys/allowlist-sync, the explicit
// admin action that applies the enabled-model allowlist to every agent key.
// A dry run unless ?apply=true; owner/admin only; the pass itself is the
// handler's own suite (agent-allowlist-handler.myrmidon.test.ts), mocked here.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pass: vi.fn(async (..._args: unknown[]) => ({
    attempted: 2,
    updated: 0,
    skipped: [] as string[],
    dryRun: {
      wouldChange: 2,
      unchanged: 0,
      added: { "antigravity/gemini-3.8-flash-high": 2 },
      removed: {},
      changes: [
        { agentId: "agent-1", add: ["antigravity/gemini-3.8-flash-high"], remove: [] },
        { agentId: "agent-2", add: ["antigravity/gemini-3.8-flash-high"], remove: [] },
      ],
    },
  })),
  record: vi.fn(async (..._args: unknown[]) => ({})),
}));

vi.mock("../litellm-sync/agent-allowlist-handler.js", () => ({
  updateAgentAllowlistsForCompany: mocks.pass,
}));
vi.mock("../litellm-audit/service.js", () => ({
  createLiteLlmAuditService: () => ({ record: mocks.record, list: vi.fn(), get: vi.fn(), rollback: vi.fn() }),
}));
vi.mock("../litellm-costs/litellm-costs.js", () => ({ listLitellmModels: vi.fn(async () => []) }));
vi.mock("./key-budget-adapter.js", () => ({ readCompanyKeyBudgets: vi.fn(async () => ({})) }));
vi.mock("./fallback-cycles.js", () => ({
  readGatewayFallbackTopology: vi.fn(),
  updateGatewayFallbackTopology: vi.fn(),
}));

import { errorHandler } from "../../middleware/index.js";
import { litellmKeysRoutes } from "./routes.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ENABLED_ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
} as NodeJS.ProcessEnv;

const admin = {
  type: "board",
  source: "session",
  userId: "user-admin",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "admin", status: "active" }],
};
const plainMember = {
  ...admin,
  userId: "user-plain",
  memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
};

const db = { marker: "db" } as never;
const keyDeps = { marker: "key-deps" } as never;

function app(actor: unknown, env: NodeJS.ProcessEnv = ENABLED_ENV) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", litellmKeysRoutes(db, { deps: keyDeps, env }));
  server.use(errorHandler);
  return server;
}

const url = `/api/myrmidon/companies/${COMPANY_ID}/litellm/keys/allowlist-sync`;

describe("POST …/litellm/keys/allowlist-sync", () => {
  beforeEach(() => {
    mocks.pass.mockClear();
    mocks.record.mockClear();
  });

  it("is a dry run by default: reports the differences and applies nothing", async () => {
    const res = await request(app(admin)).post(url).expect(200);

    expect(mocks.pass).toHaveBeenCalledTimes(1);
    expect(mocks.pass).toHaveBeenCalledWith(db, keyDeps, COMPANY_ID, [], [], false, { apply: false });
    expect(res.body).toMatchObject({ mode: "dry-run", applied: false, attempted: 2, updated: 0 });
    expect(res.body.dryRun.wouldChange).toBe(2);
    expect(res.body.dryRun.changes).toHaveLength(2);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("applies only with ?apply=true (or 1), and writes an audit row", async () => {
    mocks.pass.mockResolvedValueOnce({ attempted: 2, updated: 2, skipped: [] } as never);

    const res = await request(app(admin)).post(`${url}?apply=true`).expect(200);

    expect(mocks.pass).toHaveBeenCalledWith(db, keyDeps, COMPANY_ID, [], [], false, { apply: true });
    expect(res.body).toMatchObject({ mode: "apply", applied: true, attempted: 2, updated: 2 });
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        category: "keys",
        action: "litellm_key_allowlists_synced",
        canRollback: false,
      }),
    );

    mocks.pass.mockClear();
    await request(app(admin)).post(`${url}?apply=1`).expect(200);
    expect(mocks.pass).toHaveBeenCalledWith(db, keyDeps, COMPANY_ID, [], [], false, { apply: true });
  });

  it("any other apply value stays a dry run", async () => {
    for (const value of ["false", "0", "yes", "", "TRUEISH"]) {
      mocks.pass.mockClear();
      const res = await request(app(admin)).post(`${url}?apply=${value}`).expect(200);
      expect(mocks.pass).toHaveBeenCalledWith(db, keyDeps, COMPANY_ID, [], [], false, { apply: false });
      expect(res.body.applied).toBe(false);
    }
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("a failed audit row does not turn an applied pass into an error", async () => {
    mocks.record.mockRejectedValueOnce(new Error("audit store down"));
    mocks.pass.mockResolvedValueOnce({ attempted: 1, updated: 1, skipped: [] } as never);

    const res = await request(app(admin)).post(`${url}?apply=true`).expect(200);

    expect(res.body.applied).toBe(true);
  });

  it("denies a plain member and runs nothing", async () => {
    await request(app(plainMember)).post(url).expect(403);
    await request(app(plainMember)).post(`${url}?apply=true`).expect(403);
    expect(mocks.pass).not.toHaveBeenCalled();
  });

  it("answers 503 enabled:false when the gateway pair is not configured", async () => {
    const res = await request(app(admin, {} as NodeJS.ProcessEnv)).post(url).expect(503);
    expect(res.body.enabled).toBe(false);
    expect(mocks.pass).not.toHaveBeenCalled();
  });

  it("is not taken for an agent id by the /:agentId routes", async () => {
    // If "allowlist-sync" were read as an agent id, the create-key route would
    // run instead and never reach the pass.
    await request(app(admin)).post(url).expect(200);
    expect(mocks.pass).toHaveBeenCalledTimes(1);
  });
});
