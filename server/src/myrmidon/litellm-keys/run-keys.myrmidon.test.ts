// server/src/myrmidon/litellm-keys/run-keys.myrmidon.test.ts
//
// myrmidon(1.8 KEY-TTL / OPE-12931): run-scoped gateway key issuance and
// revoke. Plain in-memory fakes — no database, no gateway.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_KEY_ENV_NAME,
  RUN_KEY_DEFAULT_TTL_MS,
  RUN_KEY_SECRET_PREFIX,
  mintRunGatewayKey,
  revokeRunGatewayKey,
  runKeySecretName,
} from "./run-keys.js";
import { type AgentGatewayKeyDeps, type GatewayKeyAdminPort } from "./agent-keys.js";

const ENABLED_ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
} as NodeJS.ProcessEnv;

/** A key-management port that records what it was asked to do. */
function recordingGateway(): GatewayKeyAdminPort & {
  calls: Array<{ op: string; alias: string; value?: string; models?: string[]; expires?: string }>;
  installed: Set<string>;
} {
  const calls: Array<{ op: string; alias: string; value?: string; models?: string[]; expires?: string }> = [];
  const installed = new Set<string>();
  return {
    calls,
    installed,
    async createKey({ alias, value, models, expiresAt }) {
      calls.push({ op: "create", alias, value, models, expires: expiresAt?.toISOString() });
      installed.add(alias);
    },
    async rotateKey({ alias, value, expiresAt }) {
      calls.push({ op: "rotate", alias, value, expires: expiresAt?.toISOString() });
      return installed.has(alias);
    },
    async deleteKey({ alias }) {
      calls.push({ op: "delete", alias });
      installed.delete(alias);
    },
    async setKeyAllowedModels({ alias, models }) {
      calls.push({ op: "setAllowedModels", alias, models });
      return installed.has(alias);
    },
    async getKeyInfo({ alias }) {
      if (!installed.has(alias)) return null;
      return { models: [] };
    },
  };
}

/** A deps bundle over an in-memory secret store, seeded with the admin key. */
function makeDeps(seed: Record<string, string> = { "gateway-admin": "admin-value" }) {
  const store = new Map(Object.entries(seed));
  const expiries = new Map<string, Date>();
  const descriptions = new Map<string, string>();
  const gateway = recordingGateway();
  const deps: AgentGatewayKeyDeps = {
    db: { select: () => ({ from: () => ({ where: async () => [] }) }) } as never,
    env: ENABLED_ENV,
    readSecretValue: async (_companyId, name) => store.get(name) ?? null,
    findSecretId: async (_companyId, name) => (store.has(name) ? `id-${name}` : null),
    readSecretExpiresAt: async (_companyId, name) => expiries.get(name) ?? null,
    createSecret: async ({ name, value, description, expiresAt }) => {
      store.set(name, value);
      if (expiresAt) expiries.set(name, expiresAt);
      descriptions.set(name, description ?? "");
      return { id: `id-${name}` };
    },
    rotateSecret: async (secretId, value, expiresAt) => {
      const name = secretId.replace(/^id-/, "");
      store.set(name, value);
      if (expiresAt) expiries.set(name, expiresAt);
    },
    deleteSecret: async (secretId) => {
      const name = secretId.replace(/^id-/, "");
      store.delete(name);
      expiries.delete(name);
      descriptions.delete(name);
    },
    gateway: () => gateway,
  };
  return { deps, store, expiries, gateway, descriptions };
}

describe("myrmidon(1.8 KEY-TTL / OPE-12931) run gateway keys", () => {
  it("mints under a run-derived name and writes both halves with one deadline", async () => {
    const { deps, store, gateway } = makeDeps();
    const before = Date.now();
    const minted = await mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" });

    expect(minted.secretName).toBe(`${RUN_KEY_SECRET_PREFIX}run-1`);
    expect(minted.value).toMatch(/^[0-9a-f]{64}$/);
    // One deadline computed once: the gateway `expires` equals the store
    // `expiresAt` equals the value handed back, within the default 2 h TTL.
    const expires = gateway.calls[0]!.expires!;
    expect(expires).toBe(minted.expiresAt);
    expect(new Date(expires).getTime()).toBeGreaterThanOrEqual(before + RUN_KEY_DEFAULT_TTL_MS - 50);
    expect(new Date(expires).getTime()).toBeLessThanOrEqual(Date.now() + RUN_KEY_DEFAULT_TTL_MS + 50);
    expect(gateway.calls).toEqual([
      { op: "create", alias: minted.secretName, value: minted.value, models: undefined, expires },
    ]);
    expect(store.get(minted.secretName)).toBe(minted.value);
  });

  it("honours a caller ttl override but never exceeds the gateway maximum", async () => {
    const { deps, gateway } = makeDeps();
    const before = Date.now();
    await mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-1", ttlMs: 60_000 });
    const expiry = new Date(gateway.calls[0]!.expires!).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 60_000 - 50);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 60_000 + 50);

    await expect(
      mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-2", ttlMs: 25 * 60 * 60 * 1000 }),
    ).rejects.toMatchObject({ status: 400, details: { code: "gateway_key_ttl_invalid" } });
    await expect(
      mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-2", ttlMs: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("gives each run its own key: distinct names and distinct values", async () => {
    const { deps, store, gateway } = makeDeps();
    const first = await mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" });
    const second = await mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-2" });

    expect(first.secretName).not.toBe(second.secretName);
    expect(first.value).not.toBe(second.value);
    expect(new Set(store.values()).size).toBe(3); // admin seed + two run keys
    expect(gateway.calls.filter((call) => call.op === "create")).toHaveLength(2);
  });

  it("revokes both halves and is idempotent, still deleting the gateway alias", async () => {
    const { deps, store, gateway } = makeDeps();
    const minted = await mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" });
    expect(gateway.installed.has(minted.secretName)).toBe(true);

    const revoked = await revokeRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" });
    expect(revoked).toEqual({ secretName: minted.secretName, gatewayDeleted: true, secretDeleted: true });
    expect(store.has(minted.secretName)).toBe(false);
    expect(gateway.installed.has(minted.secretName)).toBe(false);

    // Second revoke over a run whose halves are gone: no throw, the gateway
    // delete is still attempted, and nothing else is reported deleted.
    const again = await revokeRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" });
    expect(again).toEqual({ secretName: minted.secretName, gatewayDeleted: true, secretDeleted: false });
    const deletes = gateway.calls.filter((call) => call.alias === minted.secretName && call.op === "delete");
    expect(deletes).toHaveLength(2);
  });

  it("deletes the gateway alias even when the store half was never written", async () => {
    const { deps, store, gateway } = makeDeps();
    const minted = await mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" });
    // Half-written mint: the store entry vanished but the gateway half lives.
    store.delete(minted.secretName);

    const revoked = await revokeRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" });
    expect(revoked.secretDeleted).toBe(false);
    expect(revoked.gatewayDeleted).toBe(true);
    expect(gateway.installed.has(minted.secretName)).toBe(false);
  });

  it("refuses to mint when key management is disabled", async () => {
    const { deps, store, gateway } = makeDeps();
    deps.env = { MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000" } as NodeJS.ProcessEnv;

    await expect(mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" })).rejects.toMatchObject({
      status: 422,
      details: { code: "gateway_keys_disabled" },
    });
    expect(store.size).toBe(1); // only the admin seed
    expect(gateway.calls).toEqual([]);
  });

  it("refuses to mint when the admin key is not resolvable", async () => {
    const { deps, store, gateway } = makeDeps({}); // no admin value in the store
    await expect(mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" })).rejects.toMatchObject({
      status: 422,
      details: { code: "gateway_admin_key_missing" },
    });
    expect(store.size).toBe(0);
    expect(gateway.calls).toEqual([]);
  });

  it("leaves the store untouched when the gateway refuses the key", async () => {
    const { deps, store, gateway } = makeDeps();
    deps.gateway = () => ({
      ...gateway,
      async createKey() {
        throw Object.assign(new Error("LLM gateway /key/generate answered 500"), { status: 422 });
      },
    }) as never;

    await expect(mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" })).rejects.toThrow();
    expect(store.size).toBe(1); // only the admin seed; no run-key half written
    expect(gateway.installed.size).toBe(0);
  });

  it("never surfaces the key value in a thrown error", async () => {
    const { deps } = makeDeps();
    deps.env = {} as NodeJS.ProcessEnv; // disabled: the mint throws before any value exists
    let message = "";
    try {
      await mintRunGatewayKey(deps, { companyId: "company-a", runId: "run-1" });
    } catch (err) {
      message = JSON.stringify(err);
    }
    expect(message).not.toMatch(/[0-9a-f]{64}/);
  });

  it("derives the env projection name from settings, defaulting to the adapter default", async () => {
    expect(DEFAULT_RUN_KEY_ENV_NAME).toBe("MYRMIDON_LLM_API_KEY");
    expect(runKeySecretName("6331f590-0e79-4171-835b-be2739e831e1")).toBe(
      "llm-gateway-run-6331f590-0e79-4171-835b-be2739e831e1",
    );
  });
});
