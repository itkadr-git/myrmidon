// server/src/myrmidon/litellm-sync/agent-allowlist-bindings.myrmidon.test.ts
//
// myrmidon(1.6.7 LITELLM-BOARD-SYNC): how the allowlist pass finds an agent's
// gateway key on a live board.
//
// A live agent's key is not a `llm-gateway-key-<name>-<id>` secret: it is the
// company secret its card binds as `adapter_config.env.MYRMIDON_LLM_API_KEY`
// (a `secret_ref`), or, failing that, as `apiKey`. The pass follows the
// binding to the secret VALUE and addresses the gateway key by the sha256 of
// that value (`/key/update` `key`: LiteLLM v1.104.1 reads a `key` that does not
// start with "sk-" as an already-hashed token, so the hash is right for every
// key shape). Rules kept from the existing handler: an empty gateway list means
// "all models" and is left alone, and an empty list is never sent on disable.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { DISABLED_MODEL_SENTINEL } from "@myrmidon/shared";
import {
  updateAgentAllowlistsForCompany,
  updateAgentGatewayKeyWithAllowlist,
} from "./agent-allowlist-handler.js";
import type { AgentGatewayKeyDeps, GatewayKeyAdminPort } from "../litellm-keys/agent-keys.js";

const ENABLED_ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
} as NodeJS.ProcessEnv;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A scripted db: every `select()` takes the next prepared rows off the queue (models, then agents). */
function scriptedDb(results: unknown[][]): Db {
  const queue = [...results];
  return {
    select: () => {
      const rows = queue.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const step of ["from", "where", "innerJoin", "limit"]) {
        chain[step] = () => chain;
      }
      chain.then = (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject);
      return chain;
    },
  } as unknown as Db;
}

interface KeyCall {
  alias: string;
  keyHash?: string;
  models: string[];
}

/** A gateway whose keys are known by their sha256 (or, without a hash, by alias). */
function gatewayHoldingKeys(initial: Record<string, string[]>) {
  const lists = new Map(Object.entries(initial));
  const calls: KeyCall[] = [];
  const port: GatewayKeyAdminPort = {
    async createKey() {},
    async rotateKey() {
      return true;
    },
    async deleteKey() {},
    async getKeyInfo({ alias, keyHash }) {
      const models = lists.get(keyHash ?? alias);
      return models ? { models } : null;
    },
    async setKeyAllowedModels({ alias, keyHash, models }) {
      calls.push({ alias, ...(keyHash ? { keyHash } : {}), models });
      if (!lists.has(keyHash ?? alias)) return false;
      lists.set(keyHash ?? alias, models);
      return true;
    },
  };
  return { port, calls, lists };
}

function makeDeps(opts: {
  db: Db;
  gateway: GatewayKeyAdminPort;
  /** Secret values by SECRET ID (what a card binding carries). */
  byId?: Record<string, string>;
  /** Secret ids by NAME (the board-managed alias secrets and the admin key). */
  byName?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}) {
  const reads: Array<{ secretId: string; version: number | "latest" | undefined }> = [];
  const byName = { "gateway-admin": "id-admin", ...(opts.byName ?? {}) };
  const deps: AgentGatewayKeyDeps = {
    db: opts.db,
    env: opts.env ?? ENABLED_ENV,
    readSecretValue: async (_companyId, name) => (name === "gateway-admin" ? "admin-value" : null),
    findSecretId: async (_companyId, name) => byName[name as keyof typeof byName] ?? null,
    readSecretValueById: async (_companyId, secretId, version) => {
      reads.push({ secretId, version });
      return opts.byId?.[secretId] ?? null;
    },
    createSecret: async () => ({ id: "x" }),
    rotateSecret: async () => {},
    gateway: (input) => {
      // The admin key is the resolved VALUE, never the name.
      expect(input.adminKey).toBe("admin-value");
      return opts.gateway;
    },
  };
  return { deps, reads };
}

const ENABLED_MODELS = [
  { litellmModelName: "openai/gpt-4o", enabled: true },
  { litellmModelName: "anthropic/claude", enabled: true },
];

const envBinding = (secretId: string, version: number | "latest" = "latest") => ({
  env: { MYRMIDON_LLM_API_KEY: { type: "secret_ref", secretId, version } },
});

describe("updateAgentAllowlistsForCompany finds the key through the card's bindings", () => {
  it("follows env.MYRMIDON_LLM_API_KEY to the value and addresses the key by its sha256", async () => {
    const keyHash = sha256("agent-key-value-1");
    const { port, calls } = gatewayHoldingKeys({ [keyHash]: ["openai/gpt-4o", "kimi/kimi-for-coding"] });
    const db = scriptedDb([ENABLED_MODELS, [{ id: "agent-1", name: "Engineer One", adapterConfig: envBinding("sec-env") }]]);
    const { deps, reads } = makeDeps({ db, gateway: port, byId: { "sec-env": "agent-key-value-1" } });

    const result = await updateAgentAllowlistsForCompany(db, deps, "company-a");

    expect(result).toEqual({ attempted: 1, updated: 1, skipped: [] });
    expect(reads).toEqual([{ secretId: "sec-env", version: "latest" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      keyHash,
      models: ["kimi/kimi-for-coding", "openai/gpt-4o", "anthropic/claude"],
    });
    // Only the hash leaves the board, never the key value.
    expect(JSON.stringify(calls)).not.toContain("agent-key-value-1");
  });

  it("falls back to the card's apiKey binding (pinned version) when there is no env binding", async () => {
    const keyHash = sha256("agent-key-value-2");
    const { port, calls } = gatewayHoldingKeys({ [keyHash]: ["openai/gpt-4o"] });
    const db = scriptedDb([
      ENABLED_MODELS,
      [{ id: "agent-2", name: "Reviewer", adapterConfig: { apiKey: { type: "secret_ref", secretId: "sec-api", version: 3 } } }],
    ]);
    const { deps, reads } = makeDeps({ db, gateway: port, byId: { "sec-api": "agent-key-value-2" } });

    const result = await updateAgentAllowlistsForCompany(db, deps, "company-a");

    expect(result.updated).toBe(1);
    expect(reads).toEqual([{ secretId: "sec-api", version: 3 }]);
    expect(calls[0]!.keyHash).toBe(keyHash);
  });

  it("prefers the env binding over apiKey and never reads the second secret", async () => {
    const keyHash = sha256("env-key-value");
    const { port, calls } = gatewayHoldingKeys({ [keyHash]: ["openai/gpt-4o"] });
    const db = scriptedDb([
      ENABLED_MODELS,
      [
        {
          id: "agent-3",
          name: "Both",
          adapterConfig: { ...envBinding("sec-env"), apiKey: { type: "secret_ref", secretId: "sec-api", version: 1 } },
        },
      ],
    ]);
    const { deps, reads } = makeDeps({
      db,
      gateway: port,
      byId: { "sec-env": "env-key-value", "sec-api": "api-server-key-value" },
    });

    await updateAgentAllowlistsForCompany(db, deps, "company-a");

    expect(reads).toEqual([{ secretId: "sec-env", version: "latest" }]);
    expect(calls[0]!.keyHash).toBe(keyHash);
  });

  it("reads the env name MYRMIDON_LITELLM_AGENT_KEY_ENV names", async () => {
    const keyHash = sha256("custom-env-key");
    const { port, calls } = gatewayHoldingKeys({ [keyHash]: ["openai/gpt-4o"] });
    const db = scriptedDb([
      ENABLED_MODELS,
      [{ id: "agent-4", name: "Custom", adapterConfig: { env: { CUSTOM_LLM_KEY: { type: "secret_ref", secretId: "sec-custom" } } } }],
    ]);
    const { deps } = makeDeps({
      db,
      gateway: port,
      byId: { "sec-custom": "custom-env-key" },
      env: { ...ENABLED_ENV, MYRMIDON_LITELLM_AGENT_KEY_ENV: "CUSTOM_LLM_KEY" } as NodeJS.ProcessEnv,
    });

    await updateAgentAllowlistsForCompany(db, deps, "company-a");

    expect(calls[0]!.keyHash).toBe(keyHash);
  });

  it("reports a binding whose secret holds no value, and sends nothing for that agent", async () => {
    const { port, calls } = gatewayHoldingKeys({});
    const db = scriptedDb([ENABLED_MODELS, [{ id: "agent-5", name: "Orphan", adapterConfig: envBinding("sec-gone") }]]);
    const { deps } = makeDeps({ db, gateway: port, byId: {} });

    const result = await updateAgentAllowlistsForCompany(db, deps, "company-a");

    expect(calls).toHaveLength(0);
    expect(result.attempted).toBe(0);
    expect(result.skipped).toEqual(["key-binding-unresolved:agent-5"]);
  });

  it("ignores a binding that is not a secret_ref and falls back to the managed alias secret", async () => {
    const { port, calls } = gatewayHoldingKeys({ "llm-gateway-key-managed-agent-6": ["openai/gpt-4o"] });
    const db = scriptedDb([
      ENABLED_MODELS,
      [{ id: "agent-6", name: "Managed", adapterConfig: { env: { MYRMIDON_LLM_API_KEY: { type: "plain", value: "x" } } } }],
    ]);
    const { deps, reads } = makeDeps({
      db,
      gateway: port,
      byName: { "llm-gateway-key-managed-agent-6": "id-managed" },
    });

    const result = await updateAgentAllowlistsForCompany(db, deps, "company-a");

    expect(reads).toEqual([]);
    expect(result.updated).toBe(1);
    // Alias addressing, exactly as before: no hash.
    expect(calls[0]).toEqual({
      alias: "llm-gateway-key-managed-agent-6",
      models: ["openai/gpt-4o", "anthropic/claude"],
    });
  });

  it("leaves an all-models key (empty gateway list) alone, bound or not", async () => {
    const keyHash = sha256("all-models-key");
    const { port, calls } = gatewayHoldingKeys({ [keyHash]: [] });
    const db = scriptedDb([ENABLED_MODELS, [{ id: "agent-7", name: "Engineer", adapterConfig: envBinding("sec-env") }]]);
    const { deps } = makeDeps({ db, gateway: port, byId: { "sec-env": "all-models-key" } });

    const result = await updateAgentAllowlistsForCompany(db, deps, "company-a");

    expect(calls).toHaveLength(0);
    expect(result.skipped).toEqual(["key-all-models:agent-7"]);
  });

  it("disable path: a bound key gets the disabled sentinel, never an empty list", async () => {
    const keyHash = sha256("agent-key-value-8");
    const { port, calls } = gatewayHoldingKeys({ [keyHash]: ["openai/gpt-4o", "anthropic/claude"] });
    const db = scriptedDb([ENABLED_MODELS, [{ id: "agent-8", name: "Engineer", adapterConfig: envBinding("sec-env") }]]);
    const { deps } = makeDeps({ db, gateway: port, byId: { "sec-env": "agent-key-value-8" } });

    const result = await updateAgentAllowlistsForCompany(
      db,
      deps,
      "company-a",
      [],
      ["openai/gpt-4o", "anthropic/claude"],
      true,
    );

    expect(result.updated).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keyHash).toBe(keyHash);
    expect(calls[0]!.models).toEqual([DISABLED_MODEL_SENTINEL]);
    expect(calls.every((call) => call.models.length > 0)).toBe(true);
  });

  it("a key the gateway does not know is reported, not created", async () => {
    const { port, calls } = gatewayHoldingKeys({});
    const db = scriptedDb([ENABLED_MODELS, [{ id: "agent-9", name: "Unknown", adapterConfig: envBinding("sec-env") }]]);
    const { deps } = makeDeps({ db, gateway: port, byId: { "sec-env": "never-installed-key" } });

    const result = await updateAgentAllowlistsForCompany(db, deps, "company-a");

    expect(calls).toHaveLength(0);
    expect(result.skipped).toEqual(["alias-unknown-to-gateway:agent-9"]);
  });

  it("one agent's secret lookup failure never stops the pass", async () => {
    const goodHash = sha256("good-key");
    const { port, calls } = gatewayHoldingKeys({ [goodHash]: ["openai/gpt-4o"] });
    const db = scriptedDb([
      ENABLED_MODELS,
      [
        { id: "agent-bad", name: "Bad", adapterConfig: envBinding("sec-bad") },
        { id: "agent-good", name: "Good", adapterConfig: envBinding("sec-good") },
      ],
    ]);
    const { deps } = makeDeps({ db, gateway: port, byId: { "sec-good": "good-key" } });
    const lookup = deps.readSecretValueById!;
    deps.readSecretValueById = async (companyId, secretId, version) => {
      if (secretId === "sec-bad") throw new Error("store unavailable");
      return lookup(companyId, secretId, version);
    };

    const result = await updateAgentAllowlistsForCompany(db, deps, "company-a");

    expect(result.updated).toBe(1);
    expect(result.skipped).toEqual(["key-lookup-failed:agent-bad"]);
    expect(calls.map((call) => call.keyHash)).toEqual([goodHash]);
  });
});

describe("updateAgentGatewayKeyWithAllowlist uses the same lookup", () => {
  it("addresses a bound key by hash and still never sends an empty allowlist", async () => {
    const keyHash = sha256("single-agent-key");
    const { port, calls } = gatewayHoldingKeys({ [keyHash]: ["openai/gpt-4o"] });
    const db = scriptedDb([[{ id: "agent-1", name: "One", adapterConfig: envBinding("sec-env") }]]);
    const { deps } = makeDeps({ db, gateway: port, byId: { "sec-env": "single-agent-key" } });

    const result = await updateAgentGatewayKeyWithAllowlist(
      deps,
      { agentId: "agent-1", companyId: "company-a" },
      { models: [] },
    );

    expect(result.applied).toBe(true);
    expect(calls[0]).toMatchObject({ keyHash, models: [DISABLED_MODEL_SENTINEL] });
  });
});
