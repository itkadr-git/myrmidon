// server/src/myrmidon/litellm-sync/litellm-sync-pools.myrmidon.test.ts
//
// myrmidon(1.6.7 OPE-12345): the gateway deployments of a subscription pool
// are not the board's to touch, and the deployments of a removed provider are
// only the provider's own.
//
//  - for chatgpt-pool, antigravity-pool and google-ai-pool NO gateway write
//    (register, unregister, update, delete) happens on enable, disable,
//    credential rotation, provider removal or the startup reconciliation;
//  - removing a gateway-owned provider unregisters its models scoped to the
//    provider's own api_base; through the real client that deletes by
//    deployment id only the deployments in the removed models' groups that
//    carry that api_base (another provider's, a pool router's and a config-file
//    deployment of the same group stay).

import { beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import type { Db } from "@myrmidon/db";
import { createLitellmSyncService } from "./service.js";
import { createLitellmSyncClient, litellmProviderPrefix } from "./client.js";
import type { LitellmSyncPort } from "./port.js";

/** A scripted fake of the drizzle query builder: each select() takes the next prepared rows. */
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

const COMPANY_ID = "comp-pools";

function recordingPort(registered: Awaited<ReturnType<LitellmSyncPort["listRegisteredModels"]>> = []) {
  const port: Mocked<LitellmSyncPort> = {
    registerModel: vi.fn().mockResolvedValue(undefined),
    unregisterModel: vi.fn().mockResolvedValue(undefined),
    updateDeployment: vi.fn().mockResolvedValue(undefined),
    deleteDeployment: vi.fn().mockResolvedValue(undefined),
    invalidateCache: vi.fn().mockResolvedValue(undefined),
    listRegisteredModels: vi.fn().mockResolvedValue(registered),
    listChannels: vi.fn().mockResolvedValue([]),
  };
  return port;
}

/** Every method of the port that writes to the gateway. */
function expectNoGatewayWrite(port: Mocked<LitellmSyncPort>) {
  expect(port.registerModel).not.toHaveBeenCalled(); // /model/new
  expect(port.unregisterModel).not.toHaveBeenCalled(); // /model/delete by group
  expect(port.deleteDeployment).not.toHaveBeenCalled(); // /model/delete by id
  expect(port.updateDeployment).not.toHaveBeenCalled(); // /model/update
  expect(port.invalidateCache).not.toHaveBeenCalled(); // /cache/delete
}

const POOLS = [
  { type: "chatgpt-pool", model: "gpt-6.1-sol", group: "chatgpt-pool/gpt-6.1-sol" },
  { type: "antigravity-pool", model: "antigravity/gemini-3.8-flash-high", group: "antigravity/gemini-3.8-flash-high" },
  { type: "google-ai-pool", model: "gai-gemini-pro", group: "gai-gemini-pro" },
] as const;

describe("a pool provider causes no gateway write", () => {
  let port: Mocked<LitellmSyncPort>;
  beforeEach(() => {
    port = recordingPort();
  });

  for (const pool of POOLS) {
    const provider = {
      id: "prov-pool",
      companyId: COMPANY_ID,
      type: pool.type,
      baseUrl: "http://pool.test:9000",
      credentialSecretName: "model-provider-key-prov-pool",
    };

    describe(pool.type, () => {
      it("enable and disable of a model (route path) write nothing", async () => {
        const service = createLitellmSyncService({
          // one provider check per call
          db: scriptedDb([[provider], [provider]]),
          litellm: port,
          resolveCredential: async () => "pool-token",
        });

        await service.handleModelEnableDisable(COMPANY_ID, "prov-pool", pool.model, true);
        await service.handleModelEnableDisable(COMPANY_ID, "prov-pool", pool.model, false);

        expectNoGatewayWrite(port);
      });

      it("syncModel, enabled and disabled, writes nothing", async () => {
        const service = createLitellmSyncService({
          db: scriptedDb([[{ litellmModelName: pool.group }], [provider], [{ litellmModelName: pool.group }], [provider]]),
          litellm: port,
          resolveCredential: async () => "pool-token",
        });

        await service.syncModel("prov-pool", pool.model, true);
        await service.syncModel("prov-pool", pool.model, false);

        expectNoGatewayWrite(port);
      });

      it("syncProviderModels writes nothing", async () => {
        const service = createLitellmSyncService({
          db: scriptedDb([
            [{ modelName: pool.model, enabled: true }],
            [{ litellmModelName: pool.group }],
            [provider],
          ]),
          litellm: port,
          resolveCredential: async () => "pool-token",
        });

        await service.syncProviderModels("prov-pool");

        expectNoGatewayWrite(port);
      });

      it("credential rotation writes nothing (no update, no cache drop)", async () => {
        const service = createLitellmSyncService({
          db: scriptedDb([[provider], [{ litellmModelName: pool.group, enabled: true }]]),
          litellm: port,
          resolveCredential: async () => "pool-token",
        });

        await service.handleProviderCredentialRotation(COMPANY_ID, "prov-pool");

        expectNoGatewayWrite(port);
        expect(port.listRegisteredModels).not.toHaveBeenCalled();
      });

      it("provider removal writes nothing and does not even read the gateway", async () => {
        const service = createLitellmSyncService({ db: scriptedDb([]), litellm: port });

        await service.unregisterProviderModels({ type: pool.type, baseUrl: provider.baseUrl }, [pool.group]);

        expectNoGatewayWrite(port);
        expect(port.listRegisteredModels).not.toHaveBeenCalled();
      });

      it("startup reconciliation neither registers the pool model nor reclaims its group", async () => {
        const gatewayHasPoolGroup = recordingPort([
          {
            modelId: "dep-pool-1",
            litellmModelName: pool.group,
            providerType: "openai",
            baseUrl: "http://pool-router:4000",
            // even a pool group that carries the pool provider's own secret name is left alone
            credentialSecretName: provider.credentialSecretName,
          },
        ]);
        const service = createLitellmSyncService({
          db: scriptedDb([
            // enabled models of the company with their providers
            [{ litellmModelName: pool.group, enabled: true, provider }],
            // the company's providers: the footprint
            [{ credentialSecretName: provider.credentialSecretName, type: pool.type }],
          ]),
          litellm: gatewayHasPoolGroup,
          resolveCredential: async () => "pool-token",
        });

        await service.reconcileWithLitellm(COMPANY_ID);

        expectNoGatewayWrite(gatewayHasPoolGroup);
      });

      it("startup reconciliation does not register a pool group the gateway lacks", async () => {
        const gatewayEmpty = recordingPort([]);
        const service = createLitellmSyncService({
          db: scriptedDb([
            [{ litellmModelName: pool.group, enabled: true, provider }],
            [{ credentialSecretName: provider.credentialSecretName, type: pool.type }],
          ]),
          litellm: gatewayEmpty,
          resolveCredential: async () => "pool-token",
        });

        await service.reconcileWithLitellm(COMPANY_ID);

        expectNoGatewayWrite(gatewayEmpty);
      });
    });
  }

  it("a non-pool provider in the same reconciliation is still registered", async () => {
    const gateway = recordingPort([]);
    const poolProvider = {
      id: "prov-pool",
      type: "antigravity-pool",
      baseUrl: "http://pool.test:9000",
      credentialSecretName: "model-provider-key-prov-pool",
    };
    const compatProvider = {
      id: "prov-kimi",
      type: "openai-compatible",
      baseUrl: "https://api.example.invalid/v1",
      credentialSecretName: "model-provider-key-prov-kimi",
    };
    const service = createLitellmSyncService({
      db: scriptedDb([
        [
          { litellmModelName: "antigravity/gemini-3.8-flash-high", enabled: true, provider: poolProvider },
          { litellmModelName: "openai-compatible/k3", enabled: true, provider: compatProvider },
        ],
        [
          { credentialSecretName: poolProvider.credentialSecretName, type: poolProvider.type },
          { credentialSecretName: compatProvider.credentialSecretName, type: compatProvider.type },
        ],
      ]),
      litellm: gateway,
      resolveCredential: async () => "token",
    });

    await service.reconcileWithLitellm(COMPANY_ID);

    expect(gateway.registerModel).toHaveBeenCalledTimes(1);
    expect(gateway.registerModel).toHaveBeenCalledWith(
      expect.objectContaining({ litellmModelName: "openai-compatible/k3", providerType: "openai-compatible" }),
    );
  });
});

/** A fake LiteLLM admin API behind fetch: /model/info lists, /model/delete records the ids. */
function fakeGatewayFetch(deployments: Array<{ id?: string; group: string; apiBase?: string; dbModel?: boolean }>) {
  const deleted: string[] = [];
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/model/info")) {
      return new Response(
        JSON.stringify({
          data: deployments.map((d) => ({
            model_name: d.group,
            litellm_params: { model: `openai/${d.group}`, ...(d.apiBase ? { api_base: d.apiBase } : {}) },
            model_info: { ...(d.id ? { id: d.id } : {}), ...(d.dbModel !== undefined ? { db_model: d.dbModel } : {}) },
          })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/model/delete")) {
      deleted.push(JSON.parse(String(init?.body)).id);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unexpected gateway call ${url}`);
  });
  return { impl, deleted, calls };
}

describe("removing a gateway-owned provider deletes only its own deployments", () => {
  const OWN_URL = "https://api.example.invalid/v1";
  const GROUP = "openai-compatible/k3";
  const provider = { type: "openai-compatible", baseUrl: OWN_URL };

  it("unregisters each removed group scoped to the provider's api_base", async () => {
    const port = recordingPort();
    const onUnregistered = vi.fn();
    const service = createLitellmSyncService({ db: scriptedDb([]), litellm: port }, { onModelUnregistered: onUnregistered });

    await service.unregisterProviderModels(provider, [GROUP, "openai-compatible/k3-256k"]);

    expect(port.unregisterModel).toHaveBeenCalledTimes(2);
    expect(port.unregisterModel).toHaveBeenCalledWith(GROUP, { baseUrl: OWN_URL });
    expect(port.unregisterModel).toHaveBeenCalledWith("openai-compatible/k3-256k", { baseUrl: OWN_URL });
    expect(onUnregistered).toHaveBeenCalledTimes(2);
    expect(port.registerModel).not.toHaveBeenCalled();
    expect(port.updateDeployment).not.toHaveBeenCalled();
  });

  it("a provider without a base URL is scoped to deployments without an api_base", async () => {
    const port = recordingPort();
    const service = createLitellmSyncService({ db: scriptedDb([]), litellm: port });

    await service.unregisterProviderModels({ type: "openai", baseUrl: null }, ["openai/gpt-4o"]);

    expect(port.unregisterModel).toHaveBeenCalledWith("openai/gpt-4o", { baseUrl: null });
  });

  it("through the real client: deletes by id only the group's deployments on the provider's api_base", async () => {
    const gateway = fakeGatewayFetch([
      { id: "own-1", group: GROUP, apiBase: OWN_URL, dbModel: true },
      // a trailing slash does not make it another address
      { id: "own-2", group: GROUP, apiBase: `${OWN_URL}/` },
      // same group, another provider's api_base
      { id: "other-1", group: GROUP, apiBase: "https://other.example.invalid/v1" },
      // same group, the pool router's api_base
      { id: "router-1", group: GROUP, apiBase: "http://pool-router:4000" },
      // same group and address, but a deployment of the gateway config file
      { id: "config-1", group: GROUP, apiBase: OWN_URL, dbModel: false },
      // same address, a group the provider never had enabled
      { id: "group-2", group: "openai-compatible/k3-256k", apiBase: OWN_URL },
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(gateway.impl as never);
    try {
      const client = createLitellmSyncClient({ litellmBaseUrl: "http://gw.invalid", litellmAdminKey: "k" });
      const service = createLitellmSyncService({ db: scriptedDb([]), litellm: client });

      await service.unregisterProviderModels(provider, [GROUP]);
    } finally {
      fetchMock.mockRestore();
    }

    expect([...gateway.deleted].sort()).toEqual(["own-1", "own-2"]);
  });

  it("an empty model list calls nothing", async () => {
    const port = recordingPort();
    const service = createLitellmSyncService({ db: scriptedDb([]), litellm: port });

    await service.unregisterProviderModels(provider, []);

    expectNoGatewayWrite(port);
    expect(port.unregisterModel).not.toHaveBeenCalled();
  });

  it("a failing unregister surfaces to the caller (the route answers 422)", async () => {
    const port = recordingPort();
    port.unregisterModel.mockRejectedValue(new Error("gateway refused"));
    const service = createLitellmSyncService({ db: scriptedDb([]), litellm: port });

    await expect(service.unregisterProviderModels(provider, [GROUP])).rejects.toThrow("gateway refused");
  });
});

describe("the LiteLLM provider prefix of a pool type", () => {
  it("maps each pool type to the openai provider, like the other OpenAI-compatible connectors", () => {
    expect(litellmProviderPrefix("chatgpt-pool")).toBe("openai");
    expect(litellmProviderPrefix("antigravity-pool")).toBe("openai");
    expect(litellmProviderPrefix("google-ai-pool")).toBe("openai");
    expect(litellmProviderPrefix("openai-compatible")).toBe("openai");
    expect(litellmProviderPrefix("deepseek")).toBe("deepseek");
  });
});
