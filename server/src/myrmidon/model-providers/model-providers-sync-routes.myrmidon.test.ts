// server/src/myrmidon/model-providers/model-providers-sync-routes.myrmidon.test.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): the model-provider API with LiteLLM
// synchronization — what the sync layer adds on top of part A's routes and
// what it never breaks.
//
// Plain fakes: no database, no network. Access rules and parsing are part A's
// own suite (model-providers-api.myrmidon.test.ts) against the same wiring;
// here: enable/disable propagation, rotation re-registration, provider-removal
// cleanup, the allowlist hook, the sync-off shape (part-A behavior) and the
// 422 contract when the gateway fails after a persisted mutation.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi, type Mocked } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { modelProviderRoutesWithSync } from "./routes-with-sync.js";
import type { ModelProviderService, ModelProviderView } from "./service.js";
import type { LitellmSyncService } from "../litellm-sync/service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const KEY_VALUE = "sk-tes...1234";

const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };

const providerView = (id: string): ModelProviderView => ({
  id,
  type: "openai",
  name: "OpenAI main",
  baseUrl: "https://api.openai.com/v1",
  hasKey: true,
  credentialSecretName: `model-provider-key-${id}`,
  free: false,
  keyValidatedAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
});

const modelViews = [
  { id: "m1", modelName: "model-a", litellmModelName: "openai/model-a", enabled: true, free: false },
  { id: "m2", modelName: "model-b", litellmModelName: "openai/model-b", enabled: false, free: false },
];

function fakeService() {
  const service: ModelProviderService = {
    async createProvider() {
      return providerView("provider-1");
    },
    async rotateProviderKey() {
      return providerView("provider-1");
    },
    async patchProvider() {
      return providerView("provider-1");
    },
    async removeProvider() {},
    async listProviders() {
      return [providerView("provider-1")];
    },
    async readProvider() {
      return providerView("provider-1");
    },
    async listModels() {
      return modelViews;
    },
    async setModels() {
      return [
        { id: "m1", modelName: "model-a", litellmModelName: "openai/model-a", enabled: false, free: false },
        { id: "m2", modelName: "model-b", litellmModelName: "openai/model-b", enabled: true, free: false },
      ];
    },
  };
  return service;
}

function fakeSync(): Mocked<LitellmSyncService> {
  return {
    syncModel: vi.fn(async () => {}),
    syncProviderModels: vi.fn(async () => {}),
    handleModelEnableDisable: vi.fn(async () => {}),
    reconcileWithLitellm: vi.fn(async () => {}),
    handleProviderCredentialRotation: vi.fn(async () => {}),
    unregisterModels: vi.fn(async () => {}),
  } as unknown as Mocked<LitellmSyncService>;
}

function app(options: {
  sync?: LitellmSyncService | null;
  refreshAgentAllowlists?: (companyId: string) => Promise<unknown>;
} = {}) {
  const getLitellmSync = vi.fn(async () => (options.sync === undefined ? fakeSync() : options.sync));
  const refresh = options.refreshAgentAllowlists ?? vi.fn(async () => ({ attempted: 0, updated: 0, skipped: [] }));
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = member;
    next();
  });
  server.use(
    "/api",
    modelProviderRoutesWithSync({
      service: fakeService(),
      getLitellmSync,
      refreshAgentAllowlists: refresh,
    }),
  );
  server.use(errorHandler);
  return { server, getLitellmSync, refresh };
}

const base = `/api/myrmidon/companies/${COMPANY_ID}/model-providers`;

describe("MODEL-PROVIDERS B: enable/disable propagates to the gateway", () => {
  let sync: ReturnType<typeof fakeSync>;
  beforeEach(() => {
    sync = fakeSync();
  });

  it("syncs every toggled model with the state the service answered, then refreshes allowlists", async () => {
    const { server, refresh } = app({ sync });
    const res = await request(server)
      .post(`${base}/provider-1/models`)
      .send({ models: [{ modelName: "model-a", enabled: false }, { modelName: "model-b", enabled: true }] })
      .expect(200);

    // The service answered model-a disabled and model-b enabled: the gateway
    // must follow the ANSWERED state, not the request shape.
    expect(sync.handleModelEnableDisable).toHaveBeenCalledWith(COMPANY_ID, "provider-1", "model-a", false);
    expect(sync.handleModelEnableDisable).toHaveBeenCalledWith(COMPANY_ID, "provider-1", "model-b", true);
    expect(refresh).toHaveBeenCalledWith(COMPANY_ID);
    expect(res.body.models).toHaveLength(2);
  });

  it("a model update without an enabled change performs no gateway call", async () => {
    const { server, refresh } = app({ sync });
    await request(server)
      .post(`${base}/provider-1/models`)
      .send({ models: [{ modelName: "model-a", free: true }] })
      .expect(200);
    expect(sync.handleModelEnableDisable).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rotation re-registers the provider models and refreshes allowlists", async () => {
    const { server, refresh } = app({ sync });
    await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(200);
    expect(sync.handleProviderCredentialRotation).toHaveBeenCalledWith(COMPANY_ID, "provider-1");
    expect(refresh).toHaveBeenCalledWith(COMPANY_ID);
  });

  it("a plain PATCH (no key) performs no gateway call", async () => {
    const { server } = app({ sync });
    await request(server).patch(`${base}/provider-1`).send({ free: true }).expect(200);
    expect(sync.handleProviderCredentialRotation).not.toHaveBeenCalled();
  });

  it("deleting a provider unregisters its enabled models", async () => {
    const { server } = app({ sync });
    await request(server).delete(`${base}/provider-1`).expect(204);
    // Only the enabled model (model-a is enabled in the listModels fake).
    expect(sync.unregisterModels).toHaveBeenCalledWith(["openai/model-a"]);
  });
});

describe("MODEL-PROVIDERS B: sync-off behaves exactly as part A", () => {
  it("enable/disable answers 200 with no gateway resolution", async () => {
    const sync = fakeSync();
    const { server, getLitellmSync } = app({ sync: null });
    await request(server)
      .post(`${base}/provider-1/models`)
      .send({ models: [{ modelName: "model-a", enabled: true }] })
      .expect(200);
    expect(getLitellmSync).toHaveBeenCalledWith(COMPANY_ID);
    expect(sync.handleModelEnableDisable).not.toHaveBeenCalled();
  });
});

describe("MODEL-PROVIDERS B: a gateway failure after the persisted mutation", () => {
  let sync: ReturnType<typeof fakeSync>;
  beforeEach(() => {
    sync = fakeSync();
  });

  it("answers 422 litellm_sync_failed when enable/disable propagation fails", async () => {
    sync.handleModelEnableDisable.mockRejectedValue(new Error("gateway down"));
    const { server } = app({ sync });
    const res = await request(server)
      .post(`${base}/provider-1/models`)
      .send({ models: [{ modelName: "model-a", enabled: false }] })
      .expect(422);
    expect(res.body.code).toBe("litellm_sync_failed");
  });

  it("answers 422 when rotation propagation fails", async () => {
    sync.handleProviderCredentialRotation.mockRejectedValue(new Error("gateway timeout"));
    const { server } = app({ sync });
    await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(422);
  });

  it("answers 422 when the provider-removal cleanup fails", async () => {
    sync.unregisterModels.mockRejectedValue(new Error("gateway refused"));
    const { server } = app({ sync });
    await request(server).delete(`${base}/provider-1`).expect(422);
  });

  it("a rejected allowlist refresh fails the propagation as well", async () => {
    const { server } = app({
      sync,
      refreshAgentAllowlists: async () => {
        throw new Error("key update refused");
      },
    });
    const res = await request(server)
      .post(`${base}/provider-1/models`)
      .send({ models: [{ modelName: "model-a", enabled: true }] })
      .expect(422);
    expect(res.body.code).toBe("litellm_sync_failed");
  });

  it("the same company's next request still works (the guard never wedges)", async () => {
    sync.handleModelEnableDisable.mockRejectedValueOnce(new Error("transient"));
    const { server } = app({ sync });
    await request(server)
      .post(`${base}/provider-1/models`)
      .send({ models: [{ modelName: "model-a", enabled: false }] })
      .expect(422);
    await request(server)
      .post(`${base}/provider-1/models`)
      .send({ models: [{ modelName: "model-a", enabled: false }] })
      .expect(200);
  });
});
