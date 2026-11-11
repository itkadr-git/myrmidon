// server/src/myrmidon/litellm-sync/litellm-sync-pools.myrmidon.test.ts
//
// myrmidon(1.6.7 OPE-12345): the gateway deployments of a subscription pool
// are not the board's to touch, and the deployments of a removed provider are
// only the provider's own.
//
//  - for chatgpt-pool, antigravity-pool and google-ai-pool NO gateway write
//    (register, unregister, update, delete) happens on enable, disable,
//    credential rotation, provider removal or the startup reconciliation;
//  - removing a gateway-owned provider deletes by deployment id, and only the
//    deployments in the removed models' groups that carry the provider's own
//    api_base (another provider's, a pool router's and a config-file
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

        const result = await service.unregisterProviderModels(
          { type: pool.type, baseUrl: provider.baseUrl },
          [pool.group],
        );

        expect(result).toEqual({ removed: 0 });
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

describe("removing a gateway-owned provider deletes only its own deployments", () => {
  const OWN_URL = "https://api.example.invalid/v1";
  const GROUP = "openai-compatible/k3";
  const provider = { type: "openai-compatible", baseUrl: OWN_URL };

  it("deletes by deployment id the group's deployments that carry the provider's api_base", async () => {
    const port = recordingPort([
      { modelId: "own-1", litellmModelName: GROUP, providerType: "openai", baseUrl: OWN_URL, credentialSecretName: "", dbModel: true },
      // trailing slash and blanks do not make it another address
      { modelId: "own-2", litellmModelName: GROUP, providerType: "openai", baseUrl: ` ${OWN_URL}/ `, credentialSecretName: "" },
      // same group, another provider's api_base
      { modelId: "other-1", litellmModelName: GROUP, providerType: "openai", baseUrl: "https://other.example.invalid/v1", credentialSecretName: "" },
      // same group, the pool router's api_base
      { modelId: "router-1", litellmModelName: GROUP, providerType: "openai", baseUrl: "http://pool-router:4000", credentialSecretName: "" },
      // same group and address, but a deployment of the gateway config file
      { modelId: "config-1", litellmModelName: GROUP, providerType: "openai", baseUrl: OWN_URL, credentialSecretName: "", dbModel: false },
      // same address, a group the provider never had enabled
      { modelId: "group-2", litellmModelName: "openai-compatible/k3-256k", providerType: "openai", baseUrl: OWN_URL, credentialSecretName: "" },
      // no id: cannot be addressed one by one
      { litellmModelName: GROUP, providerType: "openai", baseUrl: OWN_URL, credentialSecretName: "" },
    ]);
    const onUnregistered = vi.fn();
    const service = createLitellmSyncService({ db: scriptedDb([]), litellm: port }, { onModelUnregistered: onUnregistered });

    const result = await service.unregisterProviderModels(provider, [GROUP]);

    expect(result).toEqual({ removed: 2 });
    expect(port.deleteDeployment.mock.calls.map((call) => call[0]).sort()).toEqual(["own-1", "own-2"]);
    expect(port.unregisterModel).not.toHaveBeenCalled(); // never by group name
    expect(port.registerModel).not.toHaveBeenCalled();
    expect(port.updateDeployment).not.toHaveBeenCalled();
    expect(onUnregistered).toHaveBeenCalledTimes(2);
  });

  it("a provider without a base URL matches only deployments without an api_base", async () => {
    const port = recordingPort([
      { modelId: "default-1", litellmModelName: "openai/gpt-4o", providerType: "openai", baseUrl: null, credentialSecretName: "" },
      { modelId: "custom-1", litellmModelName: "openai/gpt-4o", providerType: "openai", baseUrl: "https://proxy.example.invalid/v1", credentialSecretName: "" },
    ]);
    const service = createLitellmSyncService({ db: scriptedDb([]), litellm: port });

    await service.unregisterProviderModels({ type: "openai", baseUrl: null }, ["openai/gpt-4o"]);

    expect(port.deleteDeployment.mock.calls.map((call) => call[0])).toEqual(["default-1"]);
  });

  it("an empty model list reads and deletes nothing", async () => {
    const port = recordingPort();
    const service = createLitellmSyncService({ db: scriptedDb([]), litellm: port });

    await expect(service.unregisterProviderModels(provider, [])).resolves.toEqual({ removed: 0 });
    expect(port.listRegisteredModels).not.toHaveBeenCalled();
    expect(port.deleteDeployment).not.toHaveBeenCalled();
  });

  it("a failing delete surfaces to the caller (the route answers 422)", async () => {
    const port = recordingPort([
      { modelId: "own-1", litellmModelName: GROUP, providerType: "openai", baseUrl: OWN_URL, credentialSecretName: "" },
    ]);
    port.deleteDeployment.mockRejectedValue(new Error("gateway refused"));
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

describe("the client reports whether a deployment is a database deployment", () => {
  it("reads model_info.db_model into dbModel and leaves it out when the gateway says nothing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { model_name: "g", litellm_params: { api_base: "http://a" }, model_info: { id: "1", db_model: true } },
            { model_name: "g", litellm_params: { api_base: "http://b" }, model_info: { id: "2", db_model: false } },
            { model_name: "g", litellm_params: { api_base: "http://c" }, model_info: { id: "3" } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      const client = createLitellmSyncClient({ litellmBaseUrl: "http://gw.invalid", litellmAdminKey: "k" });
      const models = await client.listRegisteredModels();
      expect(models.map((m) => [m.modelId, m.dbModel])).toEqual([
        ["1", true],
        ["2", false],
        ["3", undefined],
      ]);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
