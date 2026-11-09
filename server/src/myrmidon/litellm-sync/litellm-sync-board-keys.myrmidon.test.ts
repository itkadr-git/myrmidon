// server/src/myrmidon/litellm-sync/litellm-sync-board-keys.myrmidon.test.ts
//
// myrmidon(1.6.7 LITELLM-BOARD-SYNC): the board-to-gateway registration
// contract, pinned against what LiteLLM v1.104.1 does with each call:
//
// - credentials travel as VALUES resolved on the board, never as a
//   `secrets/<name>` reference (the gateway has no secret manager);
// - routing order is `litellm_params.order`; `model_info` is ignored by
//   `/model/update`, and `priority`, `disabled`, `provider` are not LiteLLM
//   parameters, so none of them is sent;
// - `/model/delete` takes only `{ id }`: a model name is removed by looking its
//   deployments up first;
// - a registry name (`kimi/kimi-for-coding`) may differ from the provider's own
//   model name; the upstream `model` is built from the latter;
// - registering twice never leaves two deployments behind one name + api_base;
// - the startup reconciliation resolves provider credentials (it used to build
//   the service without a resolver and fail on the first model).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { createLitellmSyncClient } from "./client.js";
import { createLitellmSyncService } from "./service.js";
import type { LitellmSyncPort } from "./port.js";
import { startLitellmModelReconciliation, type LitellmReconcilePorts } from "./startup-reconciler.js";

/** A scripted fake of the drizzle query builder: each `select()` takes the next prepared result. */
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

interface GatewayDeployment {
  id: string;
  modelName: string;
  upstream: string;
  apiBase: string | null;
  dbModel: boolean;
}

interface GatewayCall {
  method: string;
  path: string;
  body: Record<string, any>;
}

/**
 * A stateful stand-in for the LiteLLM admin API. `/model/delete` behaves like
 * v1.104.1: the body is `{ id }`, anything else is a 422 and deletes nothing.
 */
function stubGateway(initial: GatewayDeployment[] = []) {
  const deployments = [...initial];
  const calls: GatewayCall[] = [];
  let nextId = 1;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
    calls.push({ method, path, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (path === "/model/info") {
      return json(200, {
        data: deployments.map((d) => ({
          model_name: d.modelName,
          litellm_params: { model: d.upstream, ...(d.apiBase ? { api_base: d.apiBase } : {}) },
          model_info: { id: d.id, db_model: d.dbModel },
        })),
      });
    }
    if (path === "/model/new") {
      const id = `new-${nextId++}`;
      deployments.push({
        id,
        modelName: body.model_name,
        upstream: body.litellm_params.model,
        apiBase: body.litellm_params.api_base ?? null,
        dbModel: true,
      });
      return json(200, { model_id: id });
    }
    if (path === "/model/delete") {
      if (typeof body.id !== "string") {
        return json(422, { detail: [{ loc: ["body", "id"], msg: "Field required", type: "missing" }] });
      }
      const index = deployments.findIndex((d) => d.id === body.id);
      if (index < 0) return json(400, { detail: { error: `Model with id=${body.id} not found in db` } });
      deployments.splice(index, 1);
      return json(200, { message: "Model deleted successfully" });
    }
    return json(200, {});
  }) as never);
  return { deployments, calls, fetchMock };
}

const client = () => createLitellmSyncClient({ litellmBaseUrl: "http://gw.invalid/", litellmAdminKey: "admin-value" });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LitellmSyncClient payloads (LiteLLM v1.104.1)", () => {
  it("registers a deployment with the order in litellm_params and nothing LiteLLM ignores", async () => {
    const gateway = stubGateway();
    await client().registerModel({
      litellmModelName: "chatgpt-pool/gpt-6-luna",
      providerModel: "gpt-6-luna",
      providerType: "openai",
      baseUrl: "https://pool.invalid/v1",
      credentialValue: "resolved-key-value",
      order: 2,
      weight: 3,
    });

    expect(gateway.calls).toEqual([
      {
        method: "POST",
        path: "/model/new",
        body: {
          model_name: "chatgpt-pool/gpt-6-luna",
          litellm_params: {
            model: "openai/gpt-6-luna",
            api_base: "https://pool.invalid/v1",
            api_key: "resolved-key-value",
            order: 2,
            weight: 3,
          },
          model_info: {},
        },
      },
    ]);
  });

  it("builds the upstream model from the provider's own name, not from the registry name", async () => {
    const gateway = stubGateway();
    await client().registerModel({
      litellmModelName: "kimi/kimi-for-coding",
      providerModel: "kimi-for-coding",
      providerType: "openai-compatible",
      baseUrl: "https://kimi.invalid/coding/v1",
      credentialValue: "resolved-key-value",
    });

    expect(gateway.calls[0]!.body.model_name).toBe("kimi/kimi-for-coding");
    expect(gateway.calls[0]!.body.litellm_params.model).toBe("openai/kimi-for-coding");
  });

  it("keeps the stored key on update: api_key is only sent when the board holds a value", async () => {
    const gateway = stubGateway();
    await client().updateDeployment({
      modelId: "id-a",
      litellmModelName: "openai/gpt-4o",
      providerModel: "gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.example.invalid/v1",
      order: 1,
    });
    await client().updateDeployment({
      modelId: "id-a",
      litellmModelName: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: null,
      credentialValue: "rotated-key-value",
    });

    expect(gateway.calls[0]!.body).toEqual({
      model_name: "openai/gpt-4o",
      litellm_params: { model: "openai/gpt-4o", api_base: "https://api.example.invalid/v1", order: 1 },
      model_info: { id: "id-a" },
    });
    expect(gateway.calls[0]!.body.litellm_params).not.toHaveProperty("api_key");
    expect(gateway.calls[1]!.body.litellm_params.api_key).toBe("rotated-key-value");
  });

  it("refuses a secrets/<name> reference instead of storing it as the key", async () => {
    const gateway = stubGateway();
    await expect(
      client().registerModel({
        litellmModelName: "m",
        providerType: "openai",
        baseUrl: null,
        credentialValue: "secrets/provider-key",
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "litellm_credential_reference" } });
    expect(gateway.calls).toHaveLength(0);
  });
});

describe("LitellmSyncClient.unregisterModel (/model/delete takes only { id })", () => {
  const initial: GatewayDeployment[] = [
    { id: "id-1", modelName: "kimi/kimi-for-coding", upstream: "openai/kimi-for-coding", apiBase: "https://kimi.invalid/v1", dbModel: true },
    { id: "id-2", modelName: "kimi/kimi-for-coding", upstream: "openai/kimi-for-coding", apiBase: "https://backup.invalid/v1", dbModel: true },
    { id: "id-3", modelName: "other-model", upstream: "openai/other", apiBase: null, dbModel: true },
    { id: "id-4", modelName: "static-model", upstream: "openai/static", apiBase: null, dbModel: false },
  ];

  it("looks the deployments up and deletes each by id, never by name", async () => {
    const gateway = stubGateway(initial);
    await client().unregisterModel("kimi/kimi-for-coding");

    expect(gateway.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /model/info",
      "POST /model/delete",
      "POST /model/delete",
    ]);
    expect(gateway.calls.slice(1).map((c) => c.body)).toEqual([{ id: "id-1" }, { id: "id-2" }]);
    expect(gateway.calls.some((c) => "model_names" in c.body)).toBe(false);
    expect(gateway.deployments.map((d) => d.id)).toEqual(["id-3", "id-4"]);
  });

  it("with an api_base match removes only that endpoint's deployment", async () => {
    const gateway = stubGateway(initial);
    await client().unregisterModel("kimi/kimi-for-coding", { baseUrl: "https://kimi.invalid/v1/" });

    expect(gateway.deployments.map((d) => d.id)).toEqual(["id-2", "id-3", "id-4"]);
  });

  it("is a no-op for a name the gateway does not hold, and never targets static-config deployments", async () => {
    const gateway = stubGateway(initial);
    await client().unregisterModel("missing-model");
    await client().unregisterModel("static-model");

    expect(gateway.calls.every((c) => c.path === "/model/info")).toBe(true);
    expect(gateway.deployments).toHaveLength(4);
  });
});

describe("LitellmSyncService registration names and duplicates", () => {
  let port: ReturnType<typeof makePort>;

  function makePort() {
    return {
      registerModel: vi.fn().mockResolvedValue(undefined),
      unregisterModel: vi.fn().mockResolvedValue(undefined),
      listRegisteredModels: vi.fn().mockResolvedValue([]),
      updateDeployment: vi.fn().mockResolvedValue(undefined),
      deleteDeployment: vi.fn().mockResolvedValue(undefined),
      invalidateCache: vi.fn().mockResolvedValue(undefined),
      listChannels: vi.fn().mockResolvedValue([]),
    } satisfies LitellmSyncPort;
  }

  const KIMI_ROW = { litellmModelName: "kimi/kimi-for-coding", modelName: "kimi-for-coding" };
  const KIMI_PROVIDER = {
    id: "prov-kimi",
    type: "openai-compatible",
    baseUrl: "https://kimi.invalid/coding/v1",
    credentialSecretName: "model-provider-key-prov-kimi",
    companyId: "comp-1",
  };

  beforeEach(() => {
    port = makePort();
  });

  it("registers under the registry name with the provider's own model as upstream", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([[KIMI_ROW], [KIMI_PROVIDER]]),
      litellm: port,
      resolveCredential: async () => "resolved-key-value",
    });

    await service.syncModel("prov-kimi", "kimi-for-coding", true);

    expect(port.registerModel).toHaveBeenCalledWith({
      litellmModelName: "kimi/kimi-for-coding",
      providerModel: "kimi-for-coding",
      providerType: "openai-compatible",
      baseUrl: "https://kimi.invalid/coding/v1",
      credentialValue: "resolved-key-value",
    });
  });

  it("does not register a second deployment for the same model name and api_base", async () => {
    port.listRegisteredModels.mockResolvedValue([
      {
        modelId: "live-1",
        litellmModelName: "kimi/kimi-for-coding",
        providerType: "openai",
        baseUrl: "https://kimi.invalid/coding/v1/", // trailing slash: still the same endpoint
        credentialSecretName: "",
      },
    ]);
    const registered: string[] = [];
    const service = createLitellmSyncService(
      {
        db: scriptedDb([[KIMI_ROW], [KIMI_PROVIDER]]),
        litellm: port,
        resolveCredential: async () => "resolved-key-value",
      },
      { onModelRegistered: (name) => void registered.push(name) },
    );

    await service.syncModel("prov-kimi", "kimi-for-coding", true);

    expect(port.registerModel).not.toHaveBeenCalled();
    // The board still treats the model as registered (it is).
    expect(registered).toEqual(["kimi/kimi-for-coding"]);
  });

  it("registers an additional channel when the same name lives on another api_base", async () => {
    port.listRegisteredModels.mockResolvedValue([
      {
        modelId: "live-1",
        litellmModelName: "kimi/kimi-for-coding",
        providerType: "openai",
        baseUrl: "https://elsewhere.invalid/v1",
        credentialSecretName: "",
      },
    ]);
    const service = createLitellmSyncService({
      db: scriptedDb([[KIMI_ROW], [KIMI_PROVIDER]]),
      litellm: port,
      resolveCredential: async () => "resolved-key-value",
    });

    await service.syncModel("prov-kimi", "kimi-for-coding", true);

    expect(port.registerModel).toHaveBeenCalledTimes(1);
  });

  it("disabling removes only the deployments of the provider's own endpoint", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([[KIMI_ROW], [KIMI_PROVIDER]]),
      litellm: port,
    });

    await service.syncModel("prov-kimi", "kimi-for-coding", false);

    expect(port.unregisterModel).toHaveBeenCalledWith("kimi/kimi-for-coding", {
      baseUrl: "https://kimi.invalid/coding/v1",
    });
  });

  it("removing a plugin model can be limited to the plugin's own endpoint", async () => {
    const service = createLitellmSyncService({ db: scriptedDb([]), litellm: port });

    await service.unregisterModel("chatgpt-pool/gpt-6-luna", { baseUrl: "https://pool.invalid/v1" });
    await service.unregisterModel("chatgpt-pool/gpt-6-sol");

    expect(port.unregisterModel).toHaveBeenNthCalledWith(1, "chatgpt-pool/gpt-6-luna", { baseUrl: "https://pool.invalid/v1" });
    expect(port.unregisterModel).toHaveBeenNthCalledWith(2, "chatgpt-pool/gpt-6-sol");
  });

  describe("credential rotation in a group with several channels", () => {
    const rotatedProvider = { ...KIMI_PROVIDER, credentialSecretName: "rotated-secret" };
    const registration = (modelId: string, baseUrl: string | null) => ({
      modelId,
      litellmModelName: "kimi/kimi-for-coding",
      providerType: "openai",
      baseUrl,
      credentialSecretName: "",
    });

    it("rotates only the deployment on the provider's endpoint and leaves the group's other channels", async () => {
      port.listRegisteredModels.mockResolvedValue([
        registration("other-1", "https://elsewhere.invalid/v1"),
        registration("ours", "https://kimi.invalid/coding/v1"),
        registration("other-2", "https://third.invalid/v1"),
      ]);
      const service = createLitellmSyncService({
        db: scriptedDb([[rotatedProvider], [KIMI_ROW]]),
        litellm: port,
        resolveCredential: async () => "rotated-key-value",
      });

      await service.handleProviderCredentialRotation("comp-1", "prov-kimi");

      expect(port.updateDeployment).toHaveBeenCalledTimes(1);
      expect(port.updateDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "ours", credentialValue: "rotated-key-value", providerModel: "kimi-for-coding" }),
      );
      expect(port.deleteDeployment).not.toHaveBeenCalled();
      expect(port.registerModel).not.toHaveBeenCalled();
    });

    it("adds the provider's channel when the group has others and none is on its endpoint", async () => {
      port.listRegisteredModels.mockResolvedValue([
        registration("other-1", "https://elsewhere.invalid/v1"),
        registration("other-2", "https://third.invalid/v1"),
      ]);
      const service = createLitellmSyncService({
        db: scriptedDb([[rotatedProvider], [KIMI_ROW]]),
        litellm: port,
        resolveCredential: async () => "rotated-key-value",
      });

      await service.handleProviderCredentialRotation("comp-1", "prov-kimi");

      expect(port.registerModel).toHaveBeenCalledTimes(1);
      expect(port.updateDeployment).not.toHaveBeenCalled();
      expect(port.deleteDeployment).not.toHaveBeenCalled();
    });

    it("still follows a provider whose endpoint was edited: a lone deployment under the name is taken as its own", async () => {
      port.listRegisteredModels.mockResolvedValue([registration("ours", "https://old-endpoint.invalid/v1")]);
      const service = createLitellmSyncService({
        db: scriptedDb([[rotatedProvider], [KIMI_ROW]]),
        litellm: port,
        resolveCredential: async () => "rotated-key-value",
      });

      await service.handleProviderCredentialRotation("comp-1", "prov-kimi");

      expect(port.updateDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "ours", baseUrl: "https://kimi.invalid/coding/v1" }),
      );
    });
  });

  it("registers a plugin model with the credential VALUE resolved for the owning company", async () => {
    const resolved: Array<[string, string]> = [];
    const service = createLitellmSyncService({
      db: scriptedDb([]),
      litellm: port,
      resolveCredential: async (companyId, secretName) => {
        resolved.push([companyId, secretName]);
        return "resolved-pool-key";
      },
    });

    await service.registerPluginModel({
      companyId: "comp-1",
      modelName: "chatgpt-pool/gpt-6-luna",
      providerType: "openai",
      baseUrl: "https://pool.invalid/v1",
      credentialSecretName: "pool-credential",
      additionalConfig: { model: "openai/gpt-6-luna" },
    });

    expect(resolved).toEqual([["comp-1", "pool-credential"]]);
    expect(port.registerModel).toHaveBeenCalledWith({
      litellmModelName: "chatgpt-pool/gpt-6-luna",
      providerType: "openai",
      baseUrl: "https://pool.invalid/v1",
      credentialSecretName: "pool-credential",
      credentialValue: "resolved-pool-key",
      additionalConfig: { model: "openai/gpt-6-luna" },
    });
  });

  it("refuses a plugin model whose credential has no value instead of registering an empty key", async () => {
    const service = createLitellmSyncService({
      db: scriptedDb([]),
      litellm: port,
      resolveCredential: async () => null,
    });

    await expect(
      service.registerPluginModel({
        companyId: "comp-1",
        modelName: "chatgpt-pool/gpt-6-luna",
        providerType: "openai",
        baseUrl: "https://pool.invalid/v1",
        credentialSecretName: "pool-credential",
      }),
    ).rejects.toThrow(/credential could not be resolved/);
    expect(port.registerModel).not.toHaveBeenCalled();
  });

  it("registering the same plugin model twice leaves one deployment", async () => {
    const gateway = stubGateway();
    const service = createLitellmSyncService({
      db: scriptedDb([]),
      litellm: client(),
      resolveCredential: async () => "resolved-pool-key",
    });
    const input = {
      companyId: "comp-1",
      modelName: "chatgpt-pool/gpt-6-luna",
      providerType: "openai",
      baseUrl: "https://pool.invalid/v1",
      credentialSecretName: "pool-credential",
      additionalConfig: { model: "openai/gpt-6-luna" },
    };

    await service.registerPluginModel(input);
    await service.registerPluginModel(input);

    expect(gateway.deployments.filter((d) => d.modelName === "chatgpt-pool/gpt-6-luna")).toHaveLength(1);
  });
});

describe("startLitellmModelReconciliation resolves provider credentials", () => {
  const ENV = {
    MYRMIDON_LITELLM_BASE_URL: "http://gw.invalid",
    MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
  } as NodeJS.ProcessEnv;

  function ports(overrides: Partial<LitellmReconcilePorts>): LitellmReconcilePorts {
    return {
      listCompanyIds: async () => ["company-a"],
      readAdminKey: async () => "admin-value",
      resolveCredential: async () => null,
      reportAgentAllowlists: vi.fn(async () => ({ attempted: 0, updated: 0, skipped: [] })),
      log: { info: () => {}, warn: () => {} },
      ...overrides,
    };
  }

  const ENABLED_MODEL = {
    id: "m1",
    providerId: "prov-1",
    modelName: "gpt-6-luna",
    litellmModelName: "openai/gpt-6-luna",
    enabled: true,
    provider: {
      id: "prov-1",
      type: "openai",
      baseUrl: "https://api.example.invalid/v1",
      credentialSecretName: "model-provider-key-prov-1",
      companyId: "company-a",
    },
  };

  it("registers an enabled model with the resolved key VALUE, not the secret name", async () => {
    const gateway = stubGateway();
    const asked: Array<[string, string]> = [];
    const warnings: string[] = [];
    await startLitellmModelReconciliation(scriptedDb([[ENABLED_MODEL], [{ credentialSecretName: "model-provider-key-prov-1" }]]), {
      env: ENV,
      ports: ports({
        resolveCredential: async (_db, companyId, secretName) => {
          asked.push([companyId, secretName]);
          return "provider-key-value";
        },
        log: { info: () => {}, warn: (_fields, message) => void warnings.push(message) },
      }),
    });

    expect(warnings).toEqual([]);
    expect(asked).toEqual([["company-a", "model-provider-key-prov-1"]]);
    const registration = gateway.calls.find((c) => c.path === "/model/new");
    expect(registration?.body.litellm_params).toMatchObject({
      model: "openai/gpt-6-luna",
      api_base: "https://api.example.invalid/v1",
      api_key: "provider-key-value",
    });
    expect(JSON.stringify(gateway.calls)).not.toContain("model-provider-key-prov-1");
  });

  it("a provider whose secret has no value fails that company's pass with a warning, not an empty key", async () => {
    const gateway = stubGateway();
    const warnings: string[] = [];
    await startLitellmModelReconciliation(scriptedDb([[ENABLED_MODEL], [{ credentialSecretName: "model-provider-key-prov-1" }]]), {
      env: ENV,
      ports: ports({
        resolveCredential: async () => null,
        log: { info: () => {}, warn: (_fields, message) => void warnings.push(message) },
      }),
    });

    expect(gateway.calls.some((c) => c.path === "/model/new")).toBe(false);
    expect(warnings.some((m) => m.includes("reconciliation failed"))).toBe(true);
  });
});
