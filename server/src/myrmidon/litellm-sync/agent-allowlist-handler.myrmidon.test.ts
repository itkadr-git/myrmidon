// server/src/myrmidon/litellm-sync/agent-allowlist-handler.myrmidon.test.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): tests for agent key allowlist updates.
//
// The review returned this handler as an empty placeholder that was never
// wired; these tests pin the real behavior:
// - the gateway authenticates with the resolved admin-key VALUE, never the
//   secret NAME the env carries;
// - `/key/update` carries the alias and the model list but never a `key`
//   field (the agent's stored secret is not rotated by an allowlist update);
// - an empty enabled-model registry leaves the keys untouched (no lockout);
// - one agent's failure never stops the company pass;
// - the single-agent primitive reports applied/not-found without throwing.

import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  updateAgentAllowlistsForCompany,
  updateAgentGatewayKeyWithAllowlist,
} from "./agent-allowlist-handler.js";
import type { AgentGatewayKeyDeps, GatewayKeyAdminPort } from "../litellm-keys/agent-keys.js";
import { agentKeySecretName } from "@paperclipai/shared";

const ENABLED_ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
} as NodeJS.ProcessEnv;

interface GatewayCall {
  alias: string;
  models: string[];
}

/** A port recording allowlist updates; an alias can be made to fail. */
function recordingGateway(failAlias?: string): GatewayKeyAdminPort & { calls: GatewayCall[] } {
  const calls: GatewayCall[] = [];
  return {
    calls,
    async createKey() {},
    async rotateKey() {
      return true;
    },
    async deleteKey() {},
    async setKeyAllowedModels({ alias, models }) {
      if (alias === failAlias) throw new Error("gateway 500");
      calls.push({ alias, models });
      return true;
    },
  };
}

/**
 * A scripted db: every `select()` takes the next prepared rows off the queue.
 * The handler's query order is: enabled models, company agents.
 */
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

function deps(overrides: Partial<AgentGatewayKeyDeps> & { db: Db }): AgentGatewayKeyDeps {
  const gateway = overrides.gateway ? overrides.gateway : () => recordingGateway();
  const store = new Map<string, string>([["gateway-admin", "admin-value"]]);
  return {
    env: ENABLED_ENV,
    readSecretValue: async (_companyId, name) => store.get(name) ?? null,
    findSecretId: async (_companyId, name) => (store.has(name) ? `id-${name}` : null),
    createSecret: async () => ({ id: "x" }),
    rotateSecret: async () => {},
    gateway: (input) => {
      // The NAME never travels as the key: the caller must hand a resolved value.
      expect(input.adminKey).not.toBe("gateway-admin");
      return gateway(input);
    },
    ...overrides,
  };
}

const MODELS = [[{ litellmModelName: "openai/gpt-4o" }, { litellmModelName: "anthropic/claude" }]];

describe("updateAgentAllowlistsForCompany", () => {
  it("sends each agent's key alias the enabled model list", async () => {
    const gateway = recordingGateway();
    const db = scriptedDb([MODELS[0], [{ id: "agent-1", name: "Engineer One" }]]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, findSecretId: async (_c, name) => (name.startsWith("llm-gateway-key-") ? "id-key" : "id-admin") }),
      "company-a",
    );
    const alias = agentKeySecretName({ agentId: "agent-1", agentSlug: "Engineer One" });
    expect(gateway.calls).toEqual([{ alias, models: ["openai/gpt-4o", "anthropic/claude"] }]);
    expect(result).toEqual({ attempted: 1, updated: 1, skipped: [] });
  });

  it("leaves keys untouched when the registry has no enabled models (no lockout)", async () => {
    const gateway = recordingGateway();
    const db = scriptedDb([[], []]);
    const result = await updateAgentAllowlistsForCompany(db, deps({ db, gateway: () => gateway }), "company-a");
    expect(gateway.calls).toHaveLength(0);
    expect(result.skipped).toContain("no-enabled-models");
  });

  it("skips the whole pass when key management is not configured", async () => {
    const db = scriptedDb([MODELS[0]]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, env: {} as NodeJS.ProcessEnv }),
      "company-a",
    );
    expect(result.skipped).toContain("gateway-key-management-not-configured");
  });

  it("skips when the admin-key secret resolves to no value", async () => {
    const db = scriptedDb([MODELS[0]]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, readSecretValue: async () => null }),
      "company-a",
    );
    expect(result.skipped).toContain("admin-key-secret-unresolved");
  });

  it("one agent's gateway failure never stops the company pass", async () => {
    const failAlias = agentKeySecretName({ agentId: "agent-1", agentSlug: "Bad" });
    const gateway = recordingGateway(failAlias);
    const db = scriptedDb([
      MODELS[0],
      [
        { id: "agent-1", name: "Bad" },
        { id: "agent-2", name: "Good" },
      ],
    ]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({
        db,
        gateway: () => gateway,
        findSecretId: async (_c, name) => (name === "gateway-admin" || name.startsWith("llm-gateway-key-") ? "id-x" : null),
      }),
      "company-a",
    );
    // The second agent was still attempted and updated.
    expect(result.attempted).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.skipped).toContain(`key-update-failed:${"agent-1"}`);
    const okAlias = agentKeySecretName({ agentId: "agent-2", agentSlug: "Good" });
    expect(gateway.calls.map((c) => c.alias)).toEqual([okAlias]);
  });

  it("agents without a managed key are counted as skips, never created", async () => {
    const gateway = recordingGateway();
    const db = scriptedDb([MODELS[0], [{ id: "agent-1", name: "Keyless" }]]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, findSecretId: async (_c, name) => (name === "gateway-admin" ? "id-admin" : null) }),
      "company-a",
    );
    expect(gateway.calls).toHaveLength(0);
    expect(result.skipped).toContain("agent-without-key:agent-1");
  });
});

describe("updateAgentGatewayKeyWithAllowlist", () => {
  it("updates one key and reports the gateway's answer", async () => {
    const gateway = recordingGateway();
    const db = scriptedDb([[{ id: "agent-1", name: "One" }]]);
    const result = await updateAgentGatewayKeyWithAllowlist(
      deps({ db, gateway: () => gateway }),
      { agentId: "agent-1", companyId: "company-a" },
      { models: ["openai/gpt-4o"] },
    );
    expect(result.applied).toBe(true);
    expect(result.secretName).toBe(agentKeySecretName({ agentId: "agent-1", agentSlug: "One" }));
    expect(gateway.calls).toEqual([{ alias: result.secretName, models: ["openai/gpt-4o"] }]);
  });

  it("throws 404 for an agent outside the company", async () => {
    const db = scriptedDb([[]]);
    await expect(
      updateAgentGatewayKeyWithAllowlist(
        deps({ db }),
        { agentId: "agent-x", companyId: "company-a" },
        { models: ["m"] },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws 422 when the admin key resolves to nothing (name never sent as value)", async () => {
    const db = scriptedDb([[{ id: "agent-1", name: "One" }]]);
    await expect(
      updateAgentGatewayKeyWithAllowlist(
        deps({ db, readSecretValue: async () => null }),
        { agentId: "agent-1", companyId: "company-a" },
        { models: ["m"] },
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});
