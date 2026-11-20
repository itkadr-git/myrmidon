import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@myrmidon/db";
import { defaultAgentGatewayKeyDeps } from "../myrmidon/litellm-keys/agent-keys.js";
import { mintRunGatewayKey, revokeRunGatewayKey } from "../myrmidon/litellm-keys/run-keys.js";
import { secretService } from "../services/secrets.js";
import { heartbeatService } from "../services/heartbeat.js";
import { findRunScopedGatewayKeyRef, removeRunScopedGatewayKeyRef } from "../myrmidon/litellm-costs/bot-keys.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const lookupFault = vi.hoisted(() => ({ mode: "none" as "none" | "error" | "missing", calls: 0 }));
vi.mock("../myrmidon/litellm-costs/bot-keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../myrmidon/litellm-costs/bot-keys.js")>();
  return {
    ...actual,
    findRunScopedGatewayKeyRef: async (...args: Parameters<typeof actual.findRunScopedGatewayKeyRef>) => {
      lookupFault.calls++;
      if (lookupFault.mode === "error") throw new Error("test lookup failure");
      if (lookupFault.mode === "missing") return null;
      return actual.findRunScopedGatewayKeyRef(...args);
    },
  };
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("run key with the real secret service", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  let originalKeyFile: string | undefined;

  beforeAll(async () => {
    originalKeyFile = process.env.MYRMIDON_SECRETS_MASTER_KEY_FILE;
    directory = await mkdtemp(join(tmpdir(), "run-key-store-"));
    process.env.MYRMIDON_SECRETS_MASTER_KEY_FILE = join(directory, "master.key");
    database = await startEmbeddedPostgresTestDatabase("run-key-store-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
    if (originalKeyFile === undefined) delete process.env.MYRMIDON_SECRETS_MASTER_KEY_FILE;
    else process.env.MYRMIDON_SECRETS_MASTER_KEY_FILE = originalKeyFile;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("mints, resolves, and revokes a credential using the real secret store", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test" });
    const secrets = secretService(db);
    await secrets.create(companyId, { name: "gateway-admin", provider: "local_encrypted", value: "test-admin" });
    const active = new Map<string, string>();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/key/generate")) active.set(body.key_alias, body.key);
      else if (url.endsWith("/key/delete")) {
        for (const alias of body.key_aliases) active.delete(alias);
      }
      return new Response(JSON.stringify(url.endsWith("/key/list") ? { keys: [...active.keys()] } : {}), { status: 200 });
    }));
    const deps = defaultAgentGatewayKeyDeps(db, { MYRMIDON_LITELLM_BASE_URL: "http://gateway.test", MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin" });
    const runId = randomUUID();
    const minted = await mintRunGatewayKey(deps, { companyId, runId });
    expect(await deps.readSecretValue(companyId, minted.secretName)).toBe(minted.value);
    expect(active.get(minted.secretName)).toBe(minted.value);
    await revokeRunGatewayKey(deps, { companyId, runId });
    expect(await deps.readSecretValue(companyId, minted.secretName)).toBeNull();
    expect(active.has(minted.secretName)).toBe(false);
  }, 45_000);

  it("isolates real run bindings and invalidates an old reference on cleanup", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Projection", issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test" });
    const secrets = secretService(db);
    const firstRun = randomUUID();
    const secondRun = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    await secrets.create(companyId, { name: `llm-gateway-run-${firstRun}`, provider: "local_encrypted", value: "first-run-value", expiresAt });
    await secrets.create(companyId, { name: `llm-gateway-run-${secondRun}`, provider: "local_encrypted", value: "second-run-value", expiresAt });
    const first = await findRunScopedGatewayKeyRef(db, companyId, firstRun, {});
    const second = await findRunScopedGatewayKeyRef(db, companyId, secondRun, {});
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) throw new Error("run references missing");
    expect(first.secretRef.secretId).not.toBe(second.secretRef.secretId);
    expect(JSON.stringify(first)).not.toContain("first-run-value");
    expect((await secrets.resolveEnvBindings(companyId, { [first.envKey]: first.secretRef })).env[first.envKey]).toBe("first-run-value");
    expect(await removeRunScopedGatewayKeyRef(db, companyId, firstRun)).toBe(true);
    await expect(secrets.resolveEnvBindings(companyId, { [first.envKey]: first.secretRef })).rejects.toThrow();
    expect((await secrets.resolveEnvBindings(companyId, { [second.envKey]: second.secretRef })).env[second.envKey]).toBe("second-run-value");
  }, 45_000);

  it("mints before lookup and sends only the current run credential to Hermes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hermes", issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Hermes", role: "engineer", status: "idle", adapterType: "hermes_gateway", adapterConfig: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "test-gateway-auth", timeoutSec: 5 }, runtimeConfig: {}, permissions: {} });
    await secretService(db).create(companyId, { name: "gateway-admin", provider: "local_encrypted", value: "test-admin" });
    const oldBase = process.env.MYRMIDON_LITELLM_BASE_URL;
    const oldAdmin = process.env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET;
    process.env.MYRMIDON_LITELLM_BASE_URL = "http://gateway.test";
    process.env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET = "gateway-admin";
    const minted = new Map<string, string>();
    const delivered: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (target.endsWith("/key/generate")) minted.set(body.key_alias, body.key);
      if (target.endsWith("/v1/runs")) {
        expect(minted.get(`llm-gateway-run-${init?.headers && new Headers(init.headers).get("Idempotency-Key")}`)).toBe(body.model_credential?.api_key);
        delivered.push(body.model_credential.api_key);
        return new Response(JSON.stringify({ run_id: `remote-${delivered.length}`, status: "started" }), { status: 200 });
      }
      if (target.includes("/v1/runs/")) return new Response(JSON.stringify({ status: "completed", output: "done" }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    const heartbeat = heartbeatService(db);
    try {
      for (let i = 0; i < 2; i++) {
        const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
        expect(run).not.toBeNull();
        await heartbeat.drainActiveRunExecutions();
        expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");
        expect(await findRunScopedGatewayKeyRef(db, companyId, run!.id, {})).toBeNull();
      }
      expect(delivered).toHaveLength(2);
      expect(delivered[0]).not.toBe(delivered[1]);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      vi.unstubAllGlobals();
      if (oldBase === undefined) delete process.env.MYRMIDON_LITELLM_BASE_URL; else process.env.MYRMIDON_LITELLM_BASE_URL = oldBase;
      if (oldAdmin === undefined) delete process.env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET; else process.env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET = oldAdmin;
    }
  }, 90_000);

  it.each([
    { scenario: "lookup throws", mode: "error" as const, mismatchedBinding: false },
    { scenario: "binding is missing", mode: "missing" as const, mismatchedBinding: false },
    { scenario: "binding resolves to a different credential", mode: "none" as const, mismatchedBinding: true },
  ])("does not dispatch when $scenario", async ({ mode, mismatchedBinding }) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Hermes failure", issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Hermes", role: "engineer", status: "idle", adapterType: "hermes_gateway", adapterConfig: { apiBaseUrl: "http://127.0.0.1:8642", apiKey: "test-auth", timeoutSec: 5, ...(mismatchedBinding ? { env: { MYRMIDON_LLM_API_KEY: "different-credential" } } : {}) }, runtimeConfig: {}, permissions: {} });
    await secretService(db).create(companyId, { name: "gateway-admin", provider: "local_encrypted", value: "test-admin" });
    const oldBase = process.env.MYRMIDON_LITELLM_BASE_URL;
    const oldAdmin = process.env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET;
    const oldKeyEnv = process.env.MYRMIDON_BOT_LLM_API_KEY_ENV;
    process.env.MYRMIDON_LITELLM_BASE_URL = "http://gateway.test";
    process.env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET = "gateway-admin";
    delete process.env.MYRMIDON_BOT_LLM_API_KEY_ENV;
    lookupFault.mode = mode;
    lookupFault.calls = 0;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    const heartbeat = heartbeatService(db);
    try {
      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      expect(requests.some((url) => url.endsWith("/key/generate"))).toBe(true);
      expect(lookupFault.calls).toBeGreaterThan(0);
      expect((await heartbeat.getRun(run!.id))?.status).toBe("failed");
      expect(requests.some((url) => url.endsWith("/v1/runs"))).toBe(false);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      lookupFault.mode = "none";
      vi.unstubAllGlobals();
      if (oldBase === undefined) delete process.env.MYRMIDON_LITELLM_BASE_URL; else process.env.MYRMIDON_LITELLM_BASE_URL = oldBase;
      if (oldAdmin === undefined) delete process.env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET; else process.env.MYRMIDON_LITELLM_ADMIN_KEY_SECRET = oldAdmin;
      if (oldKeyEnv === undefined) delete process.env.MYRMIDON_BOT_LLM_API_KEY_ENV; else process.env.MYRMIDON_BOT_LLM_API_KEY_ENV = oldKeyEnv;
    }
  }, 90_000);
});
