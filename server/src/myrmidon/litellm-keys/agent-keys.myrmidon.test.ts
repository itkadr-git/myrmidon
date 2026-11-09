import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAgentMayReadOwnGatewayKey,
  assertManagedKeySecretName,
  createAgentGatewayKey,
  createGatewayKeyAdminPort,
  gatewayKeyValueHash,
  listAgentGatewayKeys,
  readAgentGatewayKey,
  revokeAgentGatewayKey,
  rotateAgentGatewayKey,
  updateAgentGatewayKeyAllowlist,
  type AgentGatewayKeyDeps,
  type GatewayKeyAdminPort,
} from "./agent-keys.js";
import { assertCardFallbacksAcyclic, assertFallbackTopologyAcyclic } from "./fallback-cycles.js";

const ENABLED_ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
} as NodeJS.ProcessEnv;

/** A key-management port that records what it was asked to do. */
function recordingGateway(): GatewayKeyAdminPort & {
  calls: Array<{ op: string; alias: string; value?: string; models?: string[] }>;
  installed: Set<string>;
  modelsByAlias: Map<string, string[]>;
} {
  const calls: Array<{ op: string; alias: string; value?: string; models?: string[] }> = [];
  const installed = new Set<string>();
  const modelsByAlias = new Map<string, string[]>();
  return {
    calls,
    installed,
    modelsByAlias,
    async createKey({ alias, value, models }) {
      calls.push({ op: "create", alias, value, models });
      installed.add(alias);
      if (models) modelsByAlias.set(alias, models);
    },
    async rotateKey({ alias, value }) {
      calls.push({ op: "rotate", alias, value });
      return installed.has(alias);
    },
    async deleteKey({ alias }) {
      calls.push({ op: "delete", alias });
      installed.delete(alias);
      modelsByAlias.delete(alias);
    },
    async setKeyAllowedModels({ alias, models }) {
      calls.push({ op: "setAllowedModels", alias, models });
      if (!installed.has(alias)) return false;
      modelsByAlias.set(alias, models);
      return true;
    },
    async getKeyInfo({ alias }) {
      if (!installed.has(alias)) return null;
      return { models: modelsByAlias.get(alias) ?? [] };
    },
  };
}

/** A deps bundle over an in-memory secret store. */
function makeDeps(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const gateway = recordingGateway();
  const deps: AgentGatewayKeyDeps = {
    db: { select: () => ({ from: () => ({ where: async () => [] }) }) } as never,
    env: ENABLED_ENV,
    readSecretValue: async (_companyId, name) => store.get(name) ?? null,
    findSecretId: async (_companyId, name) => (store.has(name) ? `id-${name}` : null),
    createSecret: async ({ name, value }) => {
      store.set(name, value);
      return { id: `id-${name}` };
    },
    rotateSecret: async (secretId, value) => {
      store.set(secretId.replace(/^id-/, ""), value);
    },
    deleteSecret: async (secretId) => {
      store.delete(secretId.replace(/^id-/, ""));
    },
    gateway: () => gateway,
  };
  return { deps, store, gateway };
}

/** A deps bundle whose agent lookup resolves one agent of a company. */
function depsWithAgent(
  agent: { id: string; name: string },
  seed: Record<string, string> = {},
  companyId = "company-a",
) {
  const base = makeDeps(seed);
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ id: agent.id, name: agent.name }] }),
      }),
    }),
  };
  void companyId;
  return { ...base, deps: { ...base.deps, db: db as never } };
}

describe("myrmidon(M2-B) agent gateway keys", () => {
  it("creates a key under a name derived from the agent and stores its value", async () => {
    const agent = { id: "agent-a", name: "Copywriter" };
    const { deps, store, gateway } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    const created = await createAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });

    expect(created.view.secretName).toBe("llm-gateway-key-copywriter-agent-a");
    expect(created.view.present).toBe(true);
    expect(created.view.valueHash).toBe(gatewayKeyValueHash(created.value));
    // The gateway got the value; the store got the same value; nothing got a hash.
    expect(gateway.calls).toEqual([
      { op: "create", alias: created.view.secretName, value: created.value },
    ]);
    expect(store.get(created.view.secretName)).toBe(created.value);
  });

  it("never answers the value again on a read", async () => {
    const agent = { id: "agent-a", name: "Copywriter" };
    const { deps } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    const created = await createAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });
    const view = await readAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });

    expect(Object.keys(view)).not.toContain("value");
    expect(view.valueHash).toBe(gatewayKeyValueHash(created.value));
  });

  it("refuses a second key for the same agent instead of overwriting it", async () => {
    const agent = { id: "agent-a", name: "Copywriter" };
    const { deps } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    await createAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });
    await expect(
      createAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rotates one agent's key without touching another agent's", async () => {
    const agentA = { id: "agent-a", name: "alpha" };
    const agentB = { id: "agent-b", name: "beta" };
    const seed = { "gateway-admin": "admin-value" };
    const a = depsWithAgent(agentA, seed);
    await createAgentGatewayKey(a.deps, { companyId: "company-a", agentId: agentA.id });
    const b = depsWithAgent(agentB, seed);
    await createAgentGatewayKey(b.deps, { companyId: "company-a", agentId: agentB.id });

    const valueOfA = a.store.get("llm-gateway-key-alpha-agent-a");
    const beforeB = b.store.get("llm-gateway-key-beta-agent-b");
    expect(beforeB).toBeDefined();

    const rotated = await rotateAgentGatewayKey(a.deps, { companyId: "company-a", agentId: agentA.id });
    expect(rotated.secretName).toBe("llm-gateway-key-alpha-agent-a");
    expect(a.store.get("llm-gateway-key-alpha-agent-a")).not.toBe(valueOfA);
    expect(gatewayKeyValueHash(a.store.get("llm-gateway-key-alpha-agent-a")!)).toBe(rotated.valueHash);
    // The other agent's secret value is untouched: that is the acceptance line.
    expect(b.store.get("llm-gateway-key-beta-agent-b")).toBe(beforeB);
    expect(a.gateway.calls.map((call) => call.alias)).toEqual([
      "llm-gateway-key-alpha-agent-a",
      "llm-gateway-key-alpha-agent-a",
    ]);
    expect(b.gateway.calls.map((call) => call.alias)).toEqual(["llm-gateway-key-beta-agent-b"]);
  });

  it("leaves the store alone when the gateway does not know the alias", async () => {
    const agent = { id: "agent-a", name: "alpha" };
    const { deps, store, gateway } = depsWithAgent(agent, {
      "gateway-admin": "admin-value",
      "llm-gateway-key-alpha-agent-a": "old-value",
    });
    // The alias is not installed in the port, so the rotation is not acknowledged.
    gateway.calls.length = 0;
    await expect(rotateAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id })).rejects.toMatchObject({
      status: 422,
    });
    expect(store.get("llm-gateway-key-alpha-agent-a")).toBe("old-value");
  });

  it("refuses to work without an admin key configured", async () => {
    const agent = { id: "agent-a", name: "alpha" };
    const { deps } = depsWithAgent(agent, {});
    const withoutAdmin = { ...deps, env: ENABLED_ENV };
    await expect(
      createAgentGatewayKey(withoutAdmin, { companyId: "company-a", agentId: agent.id }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("creates a key with an explicit model allowlist and passes it to gateway", async () => {
    const agent = { id: "agent-a", name: "researcher" };
    const { deps, store, gateway } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    const created = await createAgentGatewayKey(deps, {
      companyId: "company-a",
      agentId: agent.id,
      models: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
    });

    expect(created.view.models).toEqual(["openai/gpt-4o", "anthropic/claude-3-5-sonnet"]);
    expect(gateway.calls).toEqual([
      {
        op: "create",
        alias: created.view.secretName,
        value: created.value,
        models: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
      },
    ]);
    expect(store.get(created.view.secretName)).toBe(created.value);
  });

  it("lists agent gateway keys with their allowlist", async () => {
    const agentA = { id: "agent-a", name: "alpha" };
    const agentB = { id: "agent-b", name: "beta" };
    const allAgents = [
      { id: agentA.id, name: agentA.name },
      { id: agentB.id, name: agentB.name },
    ];
    const base = makeDeps({ "gateway-admin": "admin-value" });
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async (n: number) => allAgents.slice(0, n),
            then: (
              onfulfilled?: ((value: typeof allAgents) => unknown) | null,
              onrejected?: ((reason: unknown) => unknown) | null,
            ) => Promise.resolve(allAgents).then(onfulfilled, onrejected),
          }),
        }),
      }),
    };
    const deps = { ...base.deps, db: db as never };
    await createAgentGatewayKey(deps, {
      companyId: "company-a",
      agentId: agentA.id,
      models: ["openai/gpt-4o"],
    });

    const list = await listAgentGatewayKeys(deps, "company-a");
    expect(list.length).toBe(2);
    const alphaKey = list.find((k) => k.agentId === "agent-a")!;
    const betaKey = list.find((k) => k.agentId === "agent-b")!;
    expect(alphaKey.present).toBe(true);
    expect(alphaKey.models).toEqual(["openai/gpt-4o"]);
    expect(betaKey.present).toBe(false);
  });

  /** The listing's db stub (one agent) and a gateway that answers a 10 USD cap with 8.5 USD spent. */
  function listingDeps(readSpendWindows: AgentGatewayKeyDeps["readSpendWindows"]) {
    const agentA = { id: "agent-a", name: "alpha" };
    const base = makeDeps({ "gateway-admin": "admin-value" });
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [agentA],
            then: (
              onfulfilled?: ((value: Array<typeof agentA>) => unknown) | null,
              onrejected?: ((reason: unknown) => unknown) | null,
            ) => Promise.resolve([agentA]).then(onfulfilled, onrejected),
          }),
        }),
      }),
    };
    const deps: AgentGatewayKeyDeps = {
      ...base.deps,
      db: db as never,
      gateway: () => ({
        ...base.gateway,
        getKeyInfo: async () => ({ models: ["openai/gpt-4o"], maxBudgetUsd: 10, spendUsd: 8.5 }),
      }),
      ...(readSpendWindows ? { readSpendWindows } : {}),
    };
    return { agentA, deps };
  }

  it("shows the cap, gateway spend and ledger usage of a key", async () => {
    const { agentA, deps } = listingDeps(async () => [
      { companyId: "company-a", agentId: "agent-a", dailyCents: 300, weeklyCents: 600, zeroCostEvents: 2 },
      // Another company's ledger row for a same-named agent id must not leak in.
      { companyId: "company-b", agentId: "agent-a", dailyCents: 999_999, weeklyCents: 999_999, zeroCostEvents: 9 },
    ]);
    const created = await createAgentGatewayKey(deps, { companyId: "company-a", agentId: agentA.id });

    const [view] = await listAgentGatewayKeys(deps, "company-a");
    expect(view?.maxBudgetUsd).toBe(10);
    expect(view?.gatewaySpendUsd).toBe(8.5);
    expect(view?.usage).toMatchObject({ spentCents: 300, weeklySpentCents: 600, zeroCostEvents: 2, status: "near_cap" });
    expect(view?.usage?.utilizationPercent).toBeCloseTo(85);
    // Cap and spend only: the key value never rides along.
    expect(JSON.stringify(view)).not.toContain(created.value);
  });

  it("still lists the keys, with the cap but without ledger numbers, when the ledger read fails", async () => {
    const { agentA, deps } = listingDeps(async () => {
      throw new Error("canceling statement due to statement timeout");
    });
    await createAgentGatewayKey(deps, { companyId: "company-a", agentId: agentA.id });

    const [view] = await listAgentGatewayKeys(deps, "company-a");
    expect(view?.present).toBe(true);
    expect(view?.maxBudgetUsd).toBe(10);
    expect(view?.gatewaySpendUsd).toBe(8.5);
    expect(view?.usage).toBeNull();
  });

  it("revokes an agent gateway key, deleting from gateway and store", async () => {
    const agent = { id: "agent-a", name: "alpha" };
    const { deps, store, gateway } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    const created = await createAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });
    expect(store.has(created.view.secretName)).toBe(true);
    expect(gateway.installed.has(created.view.secretName)).toBe(true);

    const revoked = await revokeAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });
    expect(revoked.present).toBe(false);
    expect(revoked.valueHash).toBeNull();
    expect(revoked.models).toEqual([]);
    expect(store.has(created.view.secretName)).toBe(false);
    expect(gateway.installed.has(created.view.secretName)).toBe(false);
    expect(gateway.calls.some((c) => c.op === "delete" && c.alias === created.view.secretName)).toBe(true);
  });

  it("refuses to revoke an absent gateway key (404)", async () => {
    const agent = { id: "agent-a", name: "alpha" };
    const { deps } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    await expect(
      revokeAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("updates an agent gateway key allowlist without rotating value", async () => {
    const agent = { id: "agent-a", name: "alpha" };
    const { deps, store, gateway } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    const created = await createAgentGatewayKey(deps, { companyId: "company-a", agentId: agent.id });
    const originalValue = store.get(created.view.secretName);

    const updated = await updateAgentGatewayKeyAllowlist(deps, {
      companyId: "company-a",
      agentId: agent.id,
      models: ["deepseek/deepseek-chat", "openai/gpt-4o-mini"],
    });

    expect(updated.present).toBe(true);
    expect(updated.models).toEqual(["deepseek/deepseek-chat", "openai/gpt-4o-mini"]);
    expect(store.get(created.view.secretName)).toBe(originalValue);
    expect(gateway.calls).toContainEqual({
      op: "setAllowedModels",
      alias: created.view.secretName,
      models: ["deepseek/deepseek-chat", "openai/gpt-4o-mini"],
    });
  });

  it("refuses to update allowlist of absent key (404)", async () => {
    const agent = { id: "agent-a", name: "alpha" };
    const { deps } = depsWithAgent(agent, { "gateway-admin": "admin-value" });
    await expect(
      updateAgentGatewayKeyAllowlist(deps, {
        companyId: "company-a",
        agentId: agent.id,
        models: ["model-x"],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("myrmidon(M2-B) key ownership guards", () => {
  it("lets an agent read its own key and refuses another agent's", () => {
    expect(() =>
      assertAgentMayReadOwnGatewayKey({ actorType: "agent", actorAgentId: "agent-a", requestedAgentId: "agent-a" }),
    ).not.toThrow();
    expect(() =>
      assertAgentMayReadOwnGatewayKey({ actorType: "agent", actorAgentId: "agent-a", requestedAgentId: "agent-b" }),
    ).toThrow(/own LLM gateway key/);
  });

  it("does not narrow a board member", () => {
    expect(() =>
      assertAgentMayReadOwnGatewayKey({ actorType: "user", actorAgentId: null, requestedAgentId: "agent-b" }),
    ).not.toThrow();
  });

  it("refuses to rotate a secret this feature does not own", () => {
    expect(() => assertManagedKeySecretName("llm-gateway-key-alpha-agent-a")).not.toThrow();
    expect(() => assertManagedKeySecretName("some-other-secret")).toThrow(/not a managed/);
  });
});

describe("myrmidon(M2-B) fallback guards", () => {
  it("rejects a card chain that loops, with the models named", () => {
    expect(() =>
      assertCardFallbacksAcyclic({ model: "model-a", models: { fallbacks: ["model-b", "model-a"] } }),
    ).toThrow(/model-a -> model-b -> model-a/);
  });

  it("accepts a card chain without a loop", () => {
    expect(() =>
      assertCardFallbacksAcyclic({ model: "model-a", models: { fallbacks: ["model-b", "model-c"] } }),
    ).not.toThrow();
  });

  it("rejects a topology that loops, naming the loop", () => {
    expect(() =>
      assertFallbackTopologyAcyclic([
        { "model-a": ["model-b"] },
        { "model-b": ["model-a"] },
      ]),
    ).toThrow(/model-a -> model-b -> model-a/);
  });

  it("rejects an unreadable topology rather than checking nothing", () => {
    expect(() => assertFallbackTopologyAcyclic({ "model-a": ["model-b"] })).toThrow(/list of/);
  });
});

describe("myrmidon(M2-B) gateway key transport", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it("sends the value in the body of the key endpoints", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown>; auth: string | undefined }> = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
          auth: req.headers.authorization,
        });
        if (req.url === "/key/update") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ key_alias: "llm-gateway-key-alpha-agent-a" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ key: "sk-returned" }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const admin = createGatewayKeyAdminPort(`http://127.0.0.1:${port}`, "admin-value");

    await admin.createKey({ alias: "llm-gateway-key-alpha-agent-a", value: "value-1" });
    const rotated = await admin.rotateKey({ alias: "llm-gateway-key-alpha-agent-a", value: "value-2" });

    expect(rotated).toBe(true);
    expect(seen.map((entry) => entry.path)).toEqual(["/key/generate", "/key/update"]);
    expect(seen[0]!.body).toEqual({ key_alias: "llm-gateway-key-alpha-agent-a", key: "value-1" });
    expect(seen[1]!.body).toEqual({ key_alias: "llm-gateway-key-alpha-agent-a", key: "value-2" });
    expect(seen.every((entry) => entry.auth === "Bearer admin-value")).toBe(true);
  });

  it("setKeyAllowedModels updates the allowlist without a key field and maps 404 to false", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown>; auth: string | undefined }> = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
          auth: req.headers.authorization,
        });
        if (req.url === "/key/update") {
          // Unknown alias on the second call: the gateway answers 404, the
          // port must report false instead of throwing (rotateKey contract).
          const unknown = (seen[seen.length - 1]!.body.key_alias as string) === "missing-alias";
          res.writeHead(unknown ? 404 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ key_alias: seen[seen.length - 1]!.body.key_alias }));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const admin = createGatewayKeyAdminPort(`http://127.0.0.1:${port}`, "admin-value");

    const applied = await admin.setKeyAllowedModels!({ alias: "llm-gateway-key-alpha-agent-a", models: ["openai/gpt-4o"] });
    expect(applied).toBe(true);
    // The value is NOT rotated: the body names the alias and the allowlist only.
    expect(seen[0]!.path).toBe("/key/update");
    expect(seen[0]!.body).toEqual({ key_alias: "llm-gateway-key-alpha-agent-a", models: ["openai/gpt-4o"] }
    );
    expect(seen[0]!.auth).toBe("Bearer admin-value");

    const missing = await admin.setKeyAllowedModels!({ alias: "missing-alias", models: [] });
    expect(missing).toBe(false);
  });

  it("deleteKey calls /key/delete with key_aliases", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        seen.push({
          path: req.url ?? "",
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deleted_keys: 1 }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const admin = createGatewayKeyAdminPort(`http://127.0.0.1:${port}`, "admin-value");

    await admin.deleteKey({ alias: "llm-gateway-key-alpha-agent-a" });
    expect(seen[0]!.path).toBe("/key/delete");
    expect(seen[0]!.body).toEqual({ key_aliases: ["llm-gateway-key-alpha-agent-a"] });
  });

  it("getKeyInfo reads the key by alias with GET /key/list (the gateway's /key/info is GET-only) and returns models, cap and spend", async () => {
    const seen: Array<{ method: string; path: string; authorization: string }> = [];
    server = createServer((req, res) => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: String(req.headers.authorization ?? ""),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          keys: [{ key_alias: "my-key", models: ["model-1", "model-2"], max_budget: 10, spend: 8 }],
          total_count: 1,
          current_page: 1,
          total_pages: 1,
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const admin = createGatewayKeyAdminPort(`http://127.0.0.1:${port}`, "admin-value");

    const info = await admin.getKeyInfo!({ alias: "my-key" });
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.path).toBe("/key/list?key_alias=my-key&return_full_object=true&size=1");
    expect(seen[0]!.authorization).toBe("Bearer admin-value");
    expect(info).toEqual({ models: ["model-1", "model-2"], maxBudgetUsd: 10, spendUsd: 8 });
  });

  it("getKeyInfo answers null when the alias is not among the listed keys, and no cap for an uncapped key", async () => {
    let answer: unknown = { keys: [], total_count: 0, current_page: 1, total_pages: 1 };
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const admin = createGatewayKeyAdminPort(`http://127.0.0.1:${port}`, "admin-value");

    expect(await admin.getKeyInfo!({ alias: "my-key" })).toBeNull();
    answer = { keys: [{ key_alias: "other-key", max_budget: 5, spend: 1 }], total_pages: 1 };
    expect(await admin.getKeyInfo!({ alias: "my-key" })).toBeNull();
    answer = { keys: [{ key_alias: "my-key", models: [], max_budget: null, spend: 0.5 }], total_pages: 1 };
    expect(await admin.getKeyInfo!({ alias: "my-key" })).toEqual({ models: [], maxBudgetUsd: null, spendUsd: 0.5 });
  });

  it("maps a gateway error to a 422 instead of a silent success", async () => {
    server = createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const admin = createGatewayKeyAdminPort(`http://127.0.0.1:${port}`, "admin-value");
    await expect(admin.createKey({ alias: "a", value: "b" })).rejects.toMatchObject({ status: 422 });
  });
});