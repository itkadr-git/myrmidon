// server/src/myrmidon/litellm-sync/litellm-sync.myrmidon.test.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): tests for LiteLLM synchronization.
//
// Tests the core functionality:
// - enable → calls /model/new
// - disable → calls /model/delete
// - startup → reconcile differences, company-scoped: only registrations that
//   carry one of the company's credential names are ever unregistered
// - credential rotation updates all provider models
// - unregisterModels clears a removed provider's models
// - secret values are not exposed in logs/payloads

import { describe, it, expect, beforeEach, vi, type Mocked } from "vitest";
import { createLitellmSyncService } from "./service.js";
import { createLitellmSyncClient } from "./client.js";
import type { LitellmSyncPort } from "./port.js";
import type { Db } from "@myrmidon/db";

/**
 * A scripted fake of the drizzle query builder: every `select()` call takes the
 * next prepared result off the queue, and every builder step (`from`, `where`,
 * `innerJoin`, `limit`) returns the same awaitable chain, so the service's real
 * query shapes (with or without `limit`) resolve to the prepared rows.
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

const OPENAI_PROVIDER = {
  id: "prov-123",
  type: "openai",
  baseUrl: "https://api.openai.com/v1",
  credentialSecretName: "secret-name-123",
};

const COMPANY_ID = "comp-789";

describe("LitellmSyncService", () => {
  let port: Mocked<LitellmSyncPort>;

  beforeEach(() => {
    port = {
      registerModel: vi.fn().mockResolvedValue(undefined),
      unregisterModel: vi.fn().mockResolvedValue(undefined),
      listRegisteredModels: vi.fn().mockResolvedValue([]),
      updateDeployment: vi.fn().mockResolvedValue(undefined),
      deleteDeployment: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("preserves LiteLLM's upstream model identifier for plugin registrations", async () => {
    const service = createLitellmSyncService({ db: scriptedDb([]), litellm: port });

    await service.registerPluginModel({
      modelName: "chatgpt-pool/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "pool-key",
      additionalConfig: { model: "openai/gpt-4o" },
    });

    expect(port.registerModel).toHaveBeenCalledWith({
      litellmModelName: "chatgpt-pool/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "pool-key",
      additionalConfig: { model: "openai/gpt-4o" },
    });
  });

  it("registers model when enabled", async () => {
    // select order in syncModel: the model row, then its provider
    const service = createLitellmSyncService({
      db: scriptedDb([[{ litellmModelName: "openai/gpt-4o" }], [OPENAI_PROVIDER]]),
      litellm: port,
    });

    await service.syncModel("prov-123", "gpt-4o", true);

    expect(port.registerModel).toHaveBeenCalledWith({
      litellmModelName: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "secret-name-123",
    });
    expect(port.unregisterModel).not.toHaveBeenCalled();
  });

  it("unregisters model when disabled", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([[{ litellmModelName: "openai/gpt-4o" }]]),
      litellm: port,
    });

    await service.syncModel("prov-123", "gpt-4o", false);

    expect(port.unregisterModel).toHaveBeenCalledWith("openai/gpt-4o");
    expect(port.registerModel).not.toHaveBeenCalled();
  });

  it("reconciles a company's models at startup", async () => {
    // select order in reconcileWithLitellm: the enabled models joined with
    // their provider, then the company's owned credential names.
    const service = createLitellmSyncService({
      db: scriptedDb([
        [
          {
            litellmModelName: "openai/gpt-4o",
            provider: {
              type: "openai",
              baseUrl: "https://api.openai.com/v1",
              credentialSecretName: "secret-name-123",
            },
          },
        ],
        [{ credentialSecretName: "secret-name-123" }],
      ]),
      litellm: port,
    });
    port.listRegisteredModels.mockResolvedValue([
      {
        litellmModelName: "openai/stale-model",
        providerType: "openai",
        baseUrl: null,
        credentialSecretName: "secret-name-123",
      },
    ]);

    await service.reconcileWithLitellm(COMPANY_ID);

    // Enabled in the database but absent from LiteLLM: registered.
    expect(port.registerModel).toHaveBeenCalledWith({
      litellmModelName: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "secret-name-123",
    });
    // Registered in LiteLLM under this company's credential and not enabled
    // in the database: removed.
    expect(port.unregisterModel).toHaveBeenCalledWith("openai/stale-model");
  });

  it("startup reconcile never unregisters registrations the company does not own", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([
        [], // no enabled models for this company
        [{ credentialSecretName: "secret-name-123" }], // the company's own credentials
      ]),
      litellm: port,
    });
    port.listRegisteredModels.mockResolvedValue([
      {
        litellmModelName: "openai/stale-model",
        providerType: "openai",
        baseUrl: null,
        credentialSecretName: "secret-name-123", // ours → reclaimable
      },
      {
        litellmModelName: "anthropic/claude-static",
        providerType: "anthropic",
        baseUrl: null,
        credentialSecretName: "", // static gateway config → never touched
      },
      {
        litellmModelName: "openai/other-tenant",
        providerType: "openai",
        baseUrl: null,
        credentialSecretName: "secret-name-other-company",
      },
    ]);

    await service.reconcileWithLitellm(COMPANY_ID);

    expect(port.unregisterModel).toHaveBeenCalledTimes(1);
    expect(port.unregisterModel).toHaveBeenCalledWith("openai/stale-model");
  });

  /** Stateful fake of the gateway registry: /model/new APPENDS, update/delete address a deployment id. */
  function fakeGateway(initial: Array<{ modelId: string; name: string; secret: string }>) {
    const deployments = [...initial];
    const absentAfterCall: string[] = [];
    let nextId = 100;
    const names = initial.map((d) => d.name);
    const check = () => {
      for (const name of new Set(names)) {
        if (!deployments.some((d) => d.name === name)) absentAfterCall.push(name);
      }
    };
    const gateway: LitellmSyncPort = {
      async registerModel(input) {
        deployments.push({ modelId: `new-${nextId++}`, name: input.litellmModelName, secret: input.credentialSecretName });
        check();
      },
      async updateDeployment(input) {
        const target = deployments.find((d) => d.modelId === input.modelId);
        if (!target) throw new Error("unknown deployment id");
        target.secret = input.credentialSecretName;
        check();
      },
      async deleteDeployment(modelId) {
        const index = deployments.findIndex((d) => d.modelId === modelId);
        if (index >= 0) deployments.splice(index, 1);
        check();
      },
      async unregisterModel(name) {
        for (let i = deployments.length - 1; i >= 0; i--) if (deployments[i].name === name) deployments.splice(i, 1);
        check();
      },
      async listRegisteredModels() {
        return deployments.map((d) => ({
          modelId: d.modelId,
          litellmModelName: d.name,
          providerType: "openai",
          baseUrl: null,
          credentialSecretName: d.secret,
        }));
      },
    };
    return { gateway, deployments, absentAfterCall };
  }

  it("rotates credentials in place: one deployment per model, new key, never absent", async () => {
    const { gateway, deployments, absentAfterCall } = fakeGateway([
      { modelId: "id-a", name: "openai/gpt-4o", secret: "old-secret" },
      { modelId: "id-b", name: "openai/gpt-4-turbo", secret: "old-secret" },
      { modelId: "id-other", name: "anthropic/other", secret: "other-secret" },
    ]);
    const service = createLitellmSyncService({
      db: scriptedDb([
        [{ ...OPENAI_PROVIDER, credentialSecretName: "new-secret-name-456", companyId: COMPANY_ID }],
        [{ litellmModelName: "openai/gpt-4o" }, { litellmModelName: "openai/gpt-4-turbo" }],
      ]),
      litellm: gateway,
    });

    await service.handleProviderCredentialRotation(COMPANY_ID, "prov-123");

    expect(deployments.filter((d) => d.name === "openai/gpt-4o")).toEqual([
      { modelId: "id-a", name: "openai/gpt-4o", secret: "new-secret-name-456" },
    ]);
    expect(deployments.filter((d) => d.name === "openai/gpt-4-turbo")).toEqual([
      { modelId: "id-b", name: "openai/gpt-4-turbo", secret: "new-secret-name-456" },
    ]);
    // another provider's deployment is untouched
    expect(deployments.find((d) => d.modelId === "id-other")?.secret).toBe("other-secret");
    expect(deployments).toHaveLength(3);
    // no gap: no model was ever missing from the registry between calls
    expect(absentAfterCall).toEqual([]);
  });

  it("rotation removes leftover duplicate deployments and registers a model the gateway lacks", async () => {
    const { gateway, deployments, absentAfterCall } = fakeGateway([
      { modelId: "id-a", name: "openai/gpt-4o", secret: "old-secret" },
      { modelId: "id-a-dup", name: "openai/gpt-4o", secret: "old-secret" },
    ]);
    const service = createLitellmSyncService({
      db: scriptedDb([
        [{ ...OPENAI_PROVIDER, credentialSecretName: "new-secret-name-456", companyId: COMPANY_ID }],
        [{ litellmModelName: "openai/gpt-4o" }, { litellmModelName: "openai/missing" }],
      ]),
      litellm: gateway,
    });

    await service.handleProviderCredentialRotation(COMPANY_ID, "prov-123");

    expect(deployments.filter((d) => d.name === "openai/gpt-4o")).toEqual([
      { modelId: "id-a", name: "openai/gpt-4o", secret: "new-secret-name-456" },
    ]);
    expect(deployments.filter((d) => d.name === "openai/missing")).toHaveLength(1);
    expect(absentAfterCall).toEqual([]);
  });

  it("rotation never uses /model/new or unregister for an existing deployment", async () => {
    port.listRegisteredModels.mockResolvedValue([
      { modelId: "id-a", litellmModelName: "openai/gpt-4o", providerType: "openai", baseUrl: null, credentialSecretName: "old" },
    ]);
    const service = createLitellmSyncService({
      db: scriptedDb([
        [{ ...OPENAI_PROVIDER, credentialSecretName: "new-secret-name-456", companyId: COMPANY_ID }],
        [{ litellmModelName: "openai/gpt-4o" }],
      ]),
      litellm: port,
    });

    await service.handleProviderCredentialRotation(COMPANY_ID, "prov-123");

    expect(port.registerModel).not.toHaveBeenCalled();
    expect(port.unregisterModel).not.toHaveBeenCalled();
    expect(port.updateDeployment).toHaveBeenCalledWith({
      modelId: "id-a",
      litellmModelName: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "new-secret-name-456",
    });
  });

  it("client sends /model/update addressed by model_info.id and keeps the secret as a reference", async () => {
    const { createLitellmSyncClient } = await import("./client.js");
    const calls: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }) as never);
    try {
      const client = createLitellmSyncClient({ litellmBaseUrl: "http://gw.invalid/", litellmAdminKey: "k" });
      await client.updateDeployment({
        modelId: "id-a", litellmModelName: "openai/gpt-4o", providerType: "openai", baseUrl: null, credentialSecretName: "new-secret",
      });
      await client.deleteDeployment("id-dup");
    } finally {
      fetchMock.mockRestore();
    }
    expect(calls[0].url).toBe("http://gw.invalid/model/update");
    expect(calls[0].body.model_info).toEqual({ id: "id-a" });
    expect(calls[0].body.litellm_params.api_key).toBe("secrets/new-secret");
    expect(calls[1]).toEqual({ url: "http://gw.invalid/model/delete", body: { id: "id-dup" } });
  });

  it("unregisterModels clears a removed provider's gateway registrations", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([]),
      litellm: port,
    });

    await service.unregisterModels(["openai/gpt-4o", "openai/gpt-4-turbo"]);

    expect(port.unregisterModel).toHaveBeenCalledTimes(2);
    expect(port.unregisterModel).toHaveBeenCalledWith("openai/gpt-4o");
    expect(port.unregisterModel).toHaveBeenCalledWith("openai/gpt-4-turbo");
  });

  it("does not expose secret values in registerModel calls", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([[{ litellmModelName: "openai/gpt-4o" }], [OPENAI_PROVIDER]]),
      litellm: port,
    });

    await service.syncModel("prov-123", "gpt-4o", true);

    const callArgs = port.registerModel.mock.calls[0]![0];
    // Only the secret NAME reference goes to LiteLLM, never a value.
    expect(callArgs.credentialSecretName).toBe("secret-name-123");
    expect(callArgs).not.toHaveProperty("credentialValue");
  });
});

describe("LitellmSyncClient", () => {
  it("registers the board alias while routing to the mapped LiteLLM model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    try {
      await createLitellmSyncClient({
        litellmBaseUrl: "http://litellm.test",
        litellmAdminKey: "admin-key",
      }).registerModel({
        litellmModelName: "chatgpt-pool/gpt-4o",
        providerType: "openai",
        baseUrl: "https://api.openai.com/v1",
        credentialSecretName: "pool-key",
        additionalConfig: { model: "openai/gpt-4o" },
      });

      expect(fetchMock).toHaveBeenCalledWith("http://litellm.test/model/new", expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model_name: "chatgpt-pool/gpt-4o",
          litellm_params: {
            model: "openai/gpt-4o",
            provider: "openai",
            api_base: "https://api.openai.com/v1",
            api_key: "secrets/pool-key",
          },
        }),
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });
});
