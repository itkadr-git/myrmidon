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
import type { Db } from "@myrmidon/db";
import {
  updateAgentAllowlistsForCompany,
  updateAgentGatewayKeyWithAllowlist,
} from "./agent-allowlist-handler.js";
import type { AgentGatewayKeyDeps, GatewayKeyAdminPort } from "../litellm-keys/agent-keys.js";
import { agentKeySecretName, DISABLED_MODEL_SENTINEL } from "@myrmidon/shared";
import { summarizeAllowlistResult } from "./allowlist-report.js";

const ENABLED_ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
} as NodeJS.ProcessEnv;

interface GatewayCall {
  alias: string;
  models: string[];
}

/** A port recording allowlist updates; an alias can be made to fail. */
function recordingGateway(
  failAlias?: string,
  initialModels: Record<string, string[]> = {},
): GatewayKeyAdminPort & { calls: GatewayCall[] } {
  const calls: GatewayCall[] = [];
  const modelLists = new Map<string, string[]>(Object.entries(initialModels));
  return {
    calls,
    async createKey() {},
    async rotateKey() {
      return true;
    },
    async deleteKey() {},
    async getKeyInfo({ alias }) {
      const models = modelLists.get(alias);
      // A key unknown to the gateway answers null; a known key always answers
      // its list (empty means ALL models).
      return models ? { models } : null;
    },
    async setKeyAllowedModels({ alias, models }) {
      if (alias === failAlias) throw new Error("gateway 500");
      calls.push({ alias, models });
      modelLists.set(alias, models);
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

const MODELS = [
  [
    { litellmModelName: "openai/gpt-4o", enabled: true },
    { litellmModelName: "anthropic/claude", enabled: true },
  ],
];

describe("updateAgentAllowlistsForCompany", () => {
  it.each(["vendor/selected", "default"])("leaves unrestricted keys untouched for card model %s", async (model) => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: [] });
    const db = scriptedDb([[], [{ id: "agent-card", name: "Card Model", adapterConfig: { model } }]]);
    const result = await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a", [], [], { cardModelsOnly: true, apply: true },
    );
    expect(result.skipped).toContain("key-all-models:agent-card");
    expect(gateway.calls).toEqual([]);
  });

  it("does not rewrite a restricted key when the card has no selected models", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: ["vendor/private"] });
    const db = scriptedDb([[], [{ id: "agent-card", name: "Card Model", adapterConfig: { model: "auto" } }]]);
    await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a", [], [], { cardModelsOnly: true, apply: true },
    );
    expect(gateway.calls).toEqual([]);
  });

  it("repairs a selected card model when the registry has no enabled models", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: ["vendor/private"] });
    const db = scriptedDb([
      [],
      [{ id: "agent-card", name: "Card Model", adapterConfig: { model: "vendor/selected" } }],
    ]);
    await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }), "company-a",
    );
    expect(gateway.calls).toEqual([{ alias, models: ["vendor/private", "vendor/selected"] }]);
  });

  it("does not grant unrelated enabled registry models in a normal reconciliation", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: ["vendor/private"] });
    const db = scriptedDb([
      [{ litellmModelName: "vendor/unrelated", enabled: true }],
      [{ id: "agent-card", name: "Card Model", adapterConfig: { model: "vendor/selected" } }],
    ]);
    await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }), "company-a",
    );
    expect(gateway.calls).toEqual([{ alias, models: ["vendor/private", "vendor/selected"] }]);
  });

  it("adds the card primary model and fallbacks to the agent key", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: ["antigravity/gemini-3.8-flash-medium"] });
    const db = scriptedDb([
      MODELS[0],
      [{ id: "agent-card", name: "Card Model", adapterConfig: {
        model: "antigravity/gemini-3.5-flash-lite",
        models: { fallbacks: ["vendor/fallback"], vision: "vendor/vision", omp: { helper: "vendor/omp-helper" } },
      } }],
    ]);

    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a",
    );

    expect(result.updated).toBe(1);
    expect(gateway.calls[0]?.models).toEqual(expect.arrayContaining([
      "antigravity/gemini-3.8-flash-medium",
      "antigravity/gemini-3.5-flash-lite",
      "vendor/fallback",
      "vendor/vision",
      "vendor/omp-helper",
    ]));
    expect(gateway.calls[0]?.models).toHaveLength(5);
  });

  it("does not grant plugin models that the agent card does not select", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: ["vendor/private"] });
    const db = scriptedDb([[{ id: "agent-card", name: "Card Model", adapterConfig: { model: "plugin/selected" } }]]);
    await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a", ["plugin/selected", "plugin/unrelated"], [],
      { includeRegistryModels: false, cardModelsOnly: true },
    );
    expect(gateway.calls).toEqual([{ alias, models: ["vendor/private", "plugin/selected"] }]);
  });

  it("repairs a missing card model and records the drift in activity", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: ["vendor/private"] });
    const db = scriptedDb([
      [{ litellmModelName: "vendor/selected", enabled: true }],
      [{ id: "agent-card", name: "Card Model", adapterConfig: { model: "vendor/selected" } }],
    ]);
    const activity: Array<{ companyId: string; agentId: string; add: string[]; remove: string[] }> = [];
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, findSecretId: async () => "id-key", recordAllowlistDrift: async (entry) => { activity.push(entry); } }),
      "company-a", [], [], { cardModelsOnly: true },
    );
    expect(result.updated).toBe(1);
    expect(gateway.calls).toEqual([{ alias, models: ["vendor/private", "vendor/selected"] }]);
    expect(activity).toEqual([{ companyId: "company-a", agentId: "agent-card", add: ["vendor/selected"], remove: [] }]);
  });

  it("limits a card-save reconciliation to the edited agent", async () => {
    const first = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const second = agentKeySecretName({ agentId: "agent-other", agentSlug: "Other" });
    const gateway = recordingGateway(undefined, { [first]: ["vendor/old"], [second]: ["vendor/old"] });
    const db = scriptedDb([
      [],
      [
        { id: "agent-card", name: "Card Model", adapterConfig: { model: "vendor/new" } },
        { id: "agent-other", name: "Other", adapterConfig: { model: "vendor/other" } },
      ],
    ]);
    await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a", [], [], { cardModelsOnly: true, agentId: "agent-card" },
    );
    expect(gateway.calls).toEqual([{ alias: first, models: ["vendor/old", "vendor/new"] }]);
  });

  it("repairs a card model absent from the registry without granting unrelated models", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: ["vendor/private"] });
    const db = scriptedDb([
      [{ litellmModelName: "vendor/unrelated", enabled: true }],
      [{ id: "agent-card", name: "Card Model", adapterConfig: { model: "vendor/selected" } }],
    ]);
    await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a", [], [], { cardModelsOnly: true },
    );
    expect(gateway.calls[0]?.models).toEqual(["vendor/private", "vendor/selected"]);
  });

  it("normalizes the litellm provider prefix on selected card models", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: ["vendor/old"] });
    const db = scriptedDb([
      [{ litellmModelName: "vendor/primary", enabled: true }, { litellmModelName: "vendor/fallback", enabled: true }],
      [{ id: "agent-card", name: "Card Model", adapterConfig: {
        model: "litellm/vendor/primary", models: { fallbacks: ["litellm/vendor/fallback"] },
      } }],
    ]);
    await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a", [], [], { cardModelsOnly: true },
    );
    expect(gateway.calls[0]?.models).toEqual(["vendor/old", "vendor/primary", "vendor/fallback"]);
  });

  it("removes a disabled registry model only from keys whose card names it", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const otherAlias = agentKeySecretName({ agentId: "agent-other", agentSlug: "Other" });
    const gateway = recordingGateway(undefined, {
      [alias]: ["vendor/enabled", "vendor/disabled", "vendor/private"],
      [otherAlias]: ["vendor/enabled", "vendor/disabled", "vendor/private"],
    });
    const db = scriptedDb([
      [{ litellmModelName: "vendor/enabled", enabled: true }, { litellmModelName: "vendor/disabled", enabled: false }],
      [
        { id: "agent-card", name: "Card Model", adapterConfig: { model: "vendor/enabled", models: { fallbacks: ["vendor/disabled"] } } },
        { id: "agent-other", name: "Other", adapterConfig: { model: "vendor/unlisted" } },
      ],
    ]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a", [], [], { cardModelsOnly: true },
    );
    expect(result.updated).toBe(2);
    expect(gateway.calls).toEqual([
      { alias, models: ["vendor/enabled", "vendor/private"] },
      { alias: otherAlias, models: ["vendor/enabled", "vendor/disabled", "vendor/private", "vendor/unlisted"] },
    ]);
  });

  it("scoped pass does not block a key whose only model is a disabled one the card does not name", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: ["vendor/disabled"] });
    const registry = [{ litellmModelName: "vendor/disabled", enabled: false }];
    // A card that names no model: the key is not rewritten at all.
    let db = scriptedDb([registry, [{ id: "agent-card", name: "Card Model", adapterConfig: { model: "auto" } }]]);
    await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a", [], [], { cardModelsOnly: true, apply: true },
    );
    expect(gateway.calls).toEqual([]);
    // A card that names another model: the disabled one stays, no sentinel.
    db = scriptedDb([registry, [{ id: "agent-card", name: "Card Model", adapterConfig: { model: "vendor/selected" } }]]);
    await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a", [], [], { cardModelsOnly: true, apply: true },
    );
    expect(gateway.calls).toEqual([{ alias, models: ["vendor/disabled", "vendor/selected"] }]);
    expect(gateway.calls.flatMap((call) => call.models)).not.toContain(DISABLED_MODEL_SENTINEL);
  });

  it("full (admin) pass removes every disabled registry model, even one the card does not name", async () => {
    const alias = agentKeySecretName({ agentId: "agent-card", agentSlug: "Card Model" });
    const gateway = recordingGateway(undefined, { [alias]: ["vendor/disabled"] });
    const db = scriptedDb([
      [{ litellmModelName: "vendor/disabled", enabled: false }],
      [{ id: "agent-card", name: "Card Model", adapterConfig: { model: "auto" } }],
    ]);
    await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a", [], [], { apply: true },
    );
    expect(gateway.calls).toEqual([{ alias, models: [DISABLED_MODEL_SENTINEL] }]);
  });

  it("sends each agent's key alias the enabled model list", async () => {
    const alias = agentKeySecretName({ agentId: "agent-1", agentSlug: "Engineer One" });
    const gateway = recordingGateway(undefined, {
      [alias]: ["openai/gpt-4o", "anthropic/claude"],
    });
    const db = scriptedDb([MODELS[0], [{ id: "agent-1", name: "Engineer One" }]]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, findSecretId: async (_c, name) => (name.startsWith("llm-gateway-key-") ? "id-key" : "id-admin") }),
      "company-a",
    );
    expect(gateway.calls).toEqual([{ alias, models: ["openai/gpt-4o", "anthropic/claude"] }]);
    expect(result).toEqual({ attempted: 1, updated: 1, skipped: [] });
  });

  it("adds lifecycle models and removes only explicitly retired names", async () => {
    const alias = agentKeySecretName({ agentId: "agent-1", agentSlug: "Engineer One" });
    const gateway = recordingGateway(undefined, {
      [alias]: ["openai/gpt-4o", "anthropic/claude"],
    });
    const db = scriptedDb([MODELS[0], [{ id: "agent-1", name: "Engineer One" }]]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a",
      ["plugin/model"],
      ["anthropic/claude"],
    );
    expect(gateway.calls).toEqual([{ alias, models: ["openai/gpt-4o", "plugin/model"] }]);
    expect(result).toMatchObject({ attempted: 1, updated: 1 });
  });
  it("leaves keys untouched when the registry has no enabled models (no lockout)", async () => {
    const gateway = recordingGateway();
    const db = scriptedDb([[], []]);
    const result = await updateAgentAllowlistsForCompany(db, deps({ db, gateway: () => gateway }), "company-a");
    expect(gateway.calls).toHaveLength(0);
    expect(result.attempted).toBe(0);
  });

  it("disable-to-zero sends the disabled sentinel, never an empty allowlist", async () => {
    // Live-verified LiteLLM v1.103.2 semantics: /key/update with models: []
    // REMOVES restrictions (the key may call every registered model), so a
    // disable pass that empties a key must send an unregistered sentinel name
    // instead. Verified on an isolated instance: sentinel -> 403 for both a
    // previously held and a never-held model; a real list applied afterwards
    // restores the key. See OPE-7257 CHANGES-3.
    const alias = agentKeySecretName({ agentId: "agent-1", agentSlug: "Engineer One" });
    const gateway = recordingGateway(undefined, {
      [alias]: ["openai/gpt-4o", "anthropic/claude"],
    });
    const db = scriptedDb([MODELS[0], [{ id: "agent-1", name: "Engineer One" }]]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, findSecretId: async () => "id-key" }),
      "company-a",
      [],
      ["openai/gpt-4o", "anthropic/claude"],
    );
    expect(gateway.calls).toEqual([{ alias, models: [DISABLED_MODEL_SENTINEL] }]);
    expect(result).toMatchObject({ attempted: 1, updated: 1 });
  });

  it("preserves models outside the registry and leaves ALL keys untouched", async () => {
    const restrictedAlias = agentKeySecretName({ agentId: "agent-1", agentSlug: "Restricted" });
    const allAlias = agentKeySecretName({ agentId: "agent-2", agentSlug: "All Models" });
    const gateway = recordingGateway(undefined, {
      [restrictedAlias]: ["openai/gpt-4o", "kimi/kimi-for-coding", "google/gemini-pro"],
      [allAlias]: [],
    });
    const db = scriptedDb([
      [
        { litellmModelName: "openai/gpt-4o", enabled: true },
        { litellmModelName: "anthropic/claude", enabled: true },
      ],
      [
        { id: "agent-1", name: "Restricted" },
        { id: "agent-2", name: "All Models" },
      ],
    ]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({
        db,
        gateway: () => gateway,
        findSecretId: async (_c, name) => (name.startsWith("llm-gateway-key-") ? `id-${name}` : "id-admin"),
      }),
      "company-a",
    );
    expect(gateway.calls).toEqual([
      { alias: restrictedAlias, models: ["openai/gpt-4o", "kimi/kimi-for-coding", "google/gemini-pro"] },
    ]);
    expect(result).toMatchObject({ attempted: 2, updated: 1 });
    expect(result.skipped).toContain("key-all-models:agent-2");
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
    const okAlias = agentKeySecretName({ agentId: "agent-2", agentSlug: "Good" });
    const gateway = recordingGateway(failAlias, { [failAlias]: ["openai/gpt-4o"], [okAlias]: ["openai/gpt-4o"] });
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

  it("translates an empty allowlist to the disabled sentinel (never unlocks)", async () => {
    const gateway = recordingGateway();
    const db = scriptedDb([[{ id: "agent-1", name: "One" }]]);
    const result = await updateAgentGatewayKeyWithAllowlist(
      deps({ db, gateway: () => gateway }),
      { agentId: "agent-1", companyId: "company-a" },
      { models: [] },
    );
    expect(result.applied).toBe(true);
    expect(gateway.calls).toEqual([
      { alias: result.secretName, models: [DISABLED_MODEL_SENTINEL] },
    ]);
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

// myrmidon(1.6.7 OPE-12345): the pass read no enabled model at all on the real
// driver (its join rows are keyed by the SQL table names) and, once fixed,
// would rewrite the lists of every restricted key. These tests pin the reading
// and the dry run that keeps startup and provider changes from applying.

/** The scripted db that also records the argument of every select(). */
function recordingDb(results: unknown[][], selectArgs: unknown[]): Db {
  const queue = [...results];
  return {
    select: (fields?: unknown) => {
      selectArgs.push(fields);
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

const KEY_DEPS = {
  findSecretId: async () => "id-key",
};

describe("updateAgentAllowlistsForCompany: reading the registry join", () => {
  it("asks for explicit flat columns, not for the bare join", async () => {
    const selectArgs: unknown[] = [];
    const db = recordingDb([[], []], selectArgs);
    await updateAgentAllowlistsForCompany(db, deps({ db, ...KEY_DEPS }), "company-a");
    expect(selectArgs[0]).toBeTruthy();
    expect(Object.keys(selectArgs[0] as object).sort()).toEqual(["enabled", "litellmModelName", "modelName"]);
  });

  it("reads rows keyed by the SQL table names, as the real driver returns a bare join", async () => {
    const alias = agentKeySecretName({ agentId: "agent-1", agentSlug: "Restricted" });
    const gateway = recordingGateway(undefined, { [alias]: ["kimi/kimi-for-coding"] });
    const db = scriptedDb([
      [
        {
          model_provider_models: { modelName: "gpt-4o", litellmModelName: "openai/gpt-4o", enabled: true },
          model_providers: { id: "p1", type: "openai" },
        },
        {
          model_provider_models: { modelName: "old", litellmModelName: "openai/old", enabled: false },
          model_providers: { id: "p1", type: "openai" },
        },
      ],
      [{ id: "agent-1", name: "Restricted", adapterConfig: { model: "openai/gpt-4o" } }],
    ]);
    const result = await updateAgentAllowlistsForCompany(db, deps({ db, gateway: () => gateway, ...KEY_DEPS }), "company-a");
    expect(gateway.calls).toEqual([{ alias, models: ["kimi/kimi-for-coding", "openai/gpt-4o"] }]);
    expect(result).toMatchObject({ attempted: 1, updated: 1 });
    expect(result.skipped).not.toContain("no-enabled-models");
  });
});

describe("updateAgentAllowlistsForCompany: dry run", () => {
  const restrictedAlias = agentKeySecretName({ agentId: "agent-1", agentSlug: "Restricted" });
  const settledAlias = agentKeySecretName({ agentId: "agent-2", agentSlug: "Settled" });
  const allAlias = agentKeySecretName({ agentId: "agent-3", agentSlug: "All Models" });
  const registryRows = [
    { litellmModelName: "openai/gpt-4o", enabled: true },
    { litellmModelName: "anthropic/claude", enabled: true },
    { litellmModelName: "openai/old", enabled: false },
  ];
  const agentRows = [
    { id: "agent-1", name: "Restricted", adapterConfig: { model: "anthropic/claude" } },
    { id: "agent-2", name: "Settled" },
    { id: "agent-3", name: "All Models" },
  ];
  const initialModels = {
    [restrictedAlias]: ["openai/gpt-4o", "kimi/kimi-for-coding", "openai/old"],
    [settledAlias]: ["kimi/kimi-for-coding", "openai/gpt-4o", "anthropic/claude"],
    [allAlias]: [],
  };

  it("reports the differences per key and sends nothing", async () => {
    const gateway = recordingGateway(undefined, initialModels);
    const db = scriptedDb([registryRows, agentRows]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, ...KEY_DEPS }),
      "company-a",
      [],
      [],
      { apply: false },
    );

    expect(gateway.calls).toEqual([]);
    expect(result.attempted).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.skipped).toEqual(["key-all-models:agent-3"]);
    expect(result.dryRun).toEqual({
      wouldChange: 1,
      unchanged: 1,
      added: { "anthropic/claude": 1 },
      removed: { "openai/old": 1 },
      changes: [{ agentId: "agent-1", add: ["anthropic/claude"], remove: ["openai/old"] }],
    });
  });

  it("the same pass applied sends exactly what the dry run announced", async () => {
    const gateway = recordingGateway(undefined, initialModels);
    const db = scriptedDb([registryRows, agentRows]);
    const result = await updateAgentAllowlistsForCompany(db, deps({ db, gateway: () => gateway, ...KEY_DEPS }), "company-a");
    expect(result.dryRun).toBeUndefined();
    expect(gateway.calls.find((call) => call.alias === restrictedAlias)?.models.sort()).toEqual(
      ["anthropic/claude", "kimi/kimi-for-coding", "openai/gpt-4o"].sort(),
    );
  });

  it("works against a gateway port that cannot write allowlists (it only reads)", async () => {
    const gateway = recordingGateway(undefined, initialModels);
    delete (gateway as { setKeyAllowedModels?: unknown }).setKeyAllowedModels;
    const db = scriptedDb([registryRows, agentRows]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, ...KEY_DEPS }),
      "company-a",
      [],
      [],
      { apply: false },
    );
    expect(result.skipped).not.toContain("gateway-port-without-allowlist-support");
    expect(result.dryRun?.wouldChange).toBe(1);
  });

  it("an empty registry still answers a (empty) report and touches no key", async () => {
    const gateway = recordingGateway(undefined, initialModels);
    const db = scriptedDb([[], []]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway }),
      "company-a",
      [],
      [],
      { apply: false },
    );
    expect(gateway.calls).toEqual([]);
    expect(result.attempted).toBe(0);
    expect(result.dryRun).toMatchObject({ wouldChange: 0, unchanged: 0, changes: [] });
  });

  it("an unconfigured gateway is skipped in a dry run as well", async () => {
    const db = scriptedDb([registryRows]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, env: {} as NodeJS.ProcessEnv }),
      "company-a",
      [],
      [],
      { apply: false },
    );
    expect(result.skipped).toContain("gateway-key-management-not-configured");
  });
});

describe("updateAgentAllowlistsForCompany: includeRegistryModels false", () => {
  it("reconciles card models without registry models on card save", async () => {
    const alias = agentKeySecretName({ agentId: "agent-1", agentSlug: "Restricted" });
    const gateway = recordingGateway(undefined, { [alias]: ["vendor/old"] });
    const db = scriptedDb([[{ id: "agent-1", name: "Restricted", adapterConfig: { model: "vendor/new" } }]]);
    const result = await updateAgentAllowlistsForCompany(
      db, deps({ db, gateway: () => gateway, ...KEY_DEPS }), "company-a", [], [],
      { includeRegistryModels: false },
    );
    expect(result.updated).toBe(1);
    expect(gateway.calls).toEqual([{ alias, models: ["vendor/old", "vendor/new"] }]);
  });

  it("handles only the names the caller passes and keeps every registry name a key holds", async () => {
    const alias = agentKeySecretName({ agentId: "agent-1", agentSlug: "Restricted" });
    const gateway = recordingGateway(undefined, { [alias]: ["openai/gpt-4o", "kimi/kimi-for-coding"] });
    // Only the agent query runs: the registry is not read at all.
    const db = scriptedDb([[{ id: "agent-1", name: "Restricted" }]]);
    const result = await updateAgentAllowlistsForCompany(
      db,
      deps({ db, gateway: () => gateway, ...KEY_DEPS }),
      "company-a",
      ["plugin/model"],
      [],
      { includeRegistryModels: false },
    );
    expect(gateway.calls).toEqual([
      { alias, models: ["openai/gpt-4o", "kimi/kimi-for-coding", "plugin/model"] },
    ]);
    expect(result).toMatchObject({ attempted: 1, updated: 1 });
  });
});

describe("summarizeAllowlistResult", () => {
  it("counts skip reasons without agent ids and keeps the dry-run totals", () => {
    const summary = summarizeAllowlistResult({
      attempted: 4,
      updated: 0,
      skipped: ["key-all-models:agent-3", "key-all-models:agent-4", "agent-without-key:agent-9"],
      dryRun: {
        wouldChange: 2,
        unchanged: 1,
        added: { "a/b": 2 },
        removed: { "c/d": 1 },
        changes: [
          { agentId: "agent-1", add: ["a/b"], remove: ["c/d"] },
          { agentId: "agent-2", add: ["a/b"], remove: [] },
        ],
      },
    });
    expect(summary).toEqual({
      mode: "dry-run",
      attempted: 4,
      updated: 0,
      skippedByReason: { "key-all-models": 2, "agent-without-key": 1 },
      keysToChange: 2,
      keysUnchanged: 1,
      namesToAdd: { "a/b": 2 },
      namesToRemove: { "c/d": 1 },
    });
    expect(JSON.stringify(summary)).not.toContain("agent-1");
  });

  it("tolerates an absent or apply-mode result", () => {
    expect(summarizeAllowlistResult(undefined)).toEqual({
      mode: "apply",
      attempted: 0,
      updated: 0,
      skippedByReason: {},
    });
    expect(summarizeAllowlistResult({ attempted: 2, updated: 2, skipped: [] })).toMatchObject({ mode: "apply", updated: 2 });
  });
});
