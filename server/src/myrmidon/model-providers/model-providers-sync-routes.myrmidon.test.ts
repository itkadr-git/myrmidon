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
import { listAvailableModelProviderTypes } from "@myrmidon/shared";
import { errorHandler } from "../../middleware/index.js";
import { modelProviderRoutesWithSync } from "./routes-with-sync.js";
import type { ModelProviderService, ModelProviderView } from "./service.js";
import { createLitellmSyncService, type LitellmSyncService } from "../litellm-sync/service.js";
import { createLitellmSyncClient } from "../litellm-sync/client.js";
import type { LitellmSyncPort } from "../litellm-sync/port.js";
import type { Db } from "@myrmidon/db";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const KEY_VALUE = "sk-tes...1234";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "admin", status: "active" }],
};
const plainMember = {
  type: "board",
  source: "session",
  userId: "user-plain",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
};

const providerView = (id: string): ModelProviderView => ({
  id,
  type: "openai",
  name: "OpenAI main",
  baseUrl: "https://api.openai.com/v1",
  hasKey: true,
  credentialSecretName: `model-provider-key-${id}`,
  free: false,
  expiresAt: null,
  packageName: null,
  rpmLimit: null,
  toolCallCompatible: null,
  toolCallCheckedAt: null,
  toolCallCheckError: null,
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
    async captureKeyRotationSnapshot() {
      return {
        secretId: "sec-1",
        secretValue: "old-key",
        models: [],
        keyValidatedAt: null,
      };
    },
    rollbackProviderKey: vi.fn(async () => {}),
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
    async checkToolCallCompatibility() {
      return providerView("provider-1");
    },
    async checkPackageExpirations() {
      return [];
    },
    async listChannels(companyId, providerId) {
      return {
        providerId,
        providerType: "chatgpt-pool",
        channels: [],
        signals: [],
      };
    },
    listAvailableTypes: () => listAvailableModelProviderTypes(),
    syncPoolSignals: async () => [],
    oauthBegin: async () => ({
      verificationUri: "http://localhost:8895/auth",
      userCode: "TEST-CODE",
      accountNumber: 1,
      expiresInSec: 900,
      intervalSec: 5,
    }),
    oauthStatus: async () => ({
      status: "pending",
      accountNumber: 1,
    }),
    oauthComplete: async () => ({
      ok: true,
      accountNumber: 1,
    }),
    oauthRefresh: async () => ({
      ok: true,
      accountNumber: 1,
    }),
    async addAccount() {
      throw new Error("not implemented in fakeService");
    },
    async deleteAccount() {
      throw new Error("not implemented in fakeService");
    },
    async startOAuth() {
      throw new Error("not implemented in fakeService");
    },
    async completeOAuth() {
      throw new Error("not implemented in fakeService");
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
    unregisterProviderModels: vi.fn(async () => {}),
    listChannels: vi.fn(async () => []),
  } as unknown as Mocked<LitellmSyncService>;
}

function app(options: {
  sync?: LitellmSyncService | null;
  refreshAgentAllowlists?: (companyId: string) => Promise<unknown>;
  actor?: unknown;
  service?: ModelProviderService;
} = {}) {
  const getLitellmSync = vi.fn(async () => (options.sync === undefined ? fakeSync() : options.sync));
  const refresh = options.refreshAgentAllowlists ?? vi.fn(async () => ({ attempted: 0, updated: 0, skipped: [] }));
  const actor = options.actor ?? member;
  const service = options.service ?? fakeService();
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    modelProviderRoutesWithSync({
      service,
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

  it("deleting a provider unregisters its enabled models, scoped to the provider's own api_base", async () => {
    const { server } = app({ sync });
    await request(server).delete(`${base}/provider-1`).expect(204);
    // Only the enabled model (model-a is enabled in the listModels fake), and
    // only the deployments that carry this provider's base URL.
    expect(sync.unregisterProviderModels).toHaveBeenCalledWith(
      { type: "openai", baseUrl: "https://api.openai.com/v1" },
      ["openai/model-a"],
    );
    // Never the group-wide delete that takes other providers' deployments along.
    expect(sync.unregisterModels).not.toHaveBeenCalled();
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

  it("answers 422 and rolls back when rotation propagation fails", async () => {
    sync.handleProviderCredentialRotation.mockRejectedValue(new Error("gateway timeout"));
    const service = fakeService();
    const { server } = app({ sync, service });
    await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(422);
    expect(service.rollbackProviderKey).toHaveBeenCalledTimes(1);
    expect(service.rollbackProviderKey).toHaveBeenCalledWith(
      COMPANY_ID,
      "provider-1",
      expect.objectContaining({ secretId: "sec-1", secretValue: "old-key" }),
    );
  });

  it("answers 422 when the provider-removal cleanup fails", async () => {
    sync.unregisterProviderModels.mockRejectedValue(new Error("gateway refused"));
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

  describe("GET /model-providers/litellm/channels (OPE-9853)", () => {
    it("returns channel list when sync is configured", async () => {
      const channelViews = [
        {
          id: "c-1",
          group: "gpt-4o",
          provider: "openai",
          providerModel: "gpt-4o-mini",
          order: 1,
          weight: 5,
        },
      ];
      sync.listChannels.mockResolvedValueOnce(channelViews);
      const { server } = app({ sync });

      const res = await request(server)
        .get(`${base}/litellm/channels`)
        .expect(200);

      expect(res.body).toEqual({
        enabled: true,
        channels: channelViews,
      });
    });

    it("returns enabled: false when sync is null", async () => {
      const { server } = app({ sync: null });
      const res = await request(server)
        .get(`${base}/litellm/channels`)
        .expect(200);

      expect(res.body.enabled).toBe(false);
      expect(res.body.channels).toEqual([]);
    });

    it("masks secret tokens in error responses", async () => {
      sync.listChannels.mockRejectedValueOnce(
        new Error("LiteLLM upstream failed with sk-live-secret-key-123456 and Bearer pcp_top_secret"),
      );
      const { server } = app({ sync });

      const res = await request(server)
        .get(`${base}/litellm/channels`)
        .expect(502);

      expect(res.body.enabled).toBe(true);
      expect(res.body.channels).toEqual([]);
      expect(res.body.error).not.toContain("sk-live-secret-key-123456");
      expect(res.body.error).not.toContain("pcp_top_secret");
      expect(res.body.error).toContain("<redacted>");
    });
  });

  it("denies plain company member on read and write (403)", async () => {
    const { server } = app({ sync, actor: plainMember });
    await request(server).get(base).expect(403);
    await request(server)
      .post(`${base}/provider-1/models`)
      .send({ models: [{ modelName: "model-a", enabled: true }] })
      .expect(403);
  });
});

// myrmidon(1.6.7 OPE-12345): pool providers and provider removal against the
// REAL sync service and a recording gateway port. The pool's gateway
// deployments are its own: no action on a pool provider reaches a write method
// of the port (/model/new, /model/delete, /model/update).

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

function expectNoGatewayWrite(port: Mocked<LitellmSyncPort>) {
  expect(port.registerModel).not.toHaveBeenCalled();
  expect(port.unregisterModel).not.toHaveBeenCalled();
  expect(port.deleteDeployment).not.toHaveBeenCalled();
  expect(port.updateDeployment).not.toHaveBeenCalled();
  expect(port.invalidateCache).not.toHaveBeenCalled();
}

function poolService(type: "chatgpt-pool" | "antigravity-pool" | "google-ai-pool"): ModelProviderService {
  const service = fakeService();
  const poolView = { ...providerView("provider-1"), type, baseUrl: "http://pool.test:9000" };
  service.readProvider = async () => poolView;
  service.rotateProviderKey = async () => poolView;
  return service;
}

describe("OPE-12345: pool providers never reach the gateway's write API", () => {
  for (const type of ["chatgpt-pool", "antigravity-pool", "google-ai-pool"] as const) {
    it(`${type}: registration, enable, disable, key rotation and removal write nothing`, async () => {
      const port = recordingPort([
        // the pool's own deployments, plus a same-named group of another provider
        { modelId: "pool-1", litellmModelName: "openai/model-a", providerType: "openai", baseUrl: "http://pool.test:9000", credentialSecretName: "" },
      ]);
      const poolProvider = { id: "provider-1", companyId: COMPANY_ID, type, baseUrl: "http://pool.test:9000", credentialSecretName: "k" };
      // enable + disable (two provider checks), then the rotation (one)
      const sync = createLitellmSyncService({
        db: scriptedDb([[poolProvider], [poolProvider], [poolProvider]]),
        litellm: port,
        resolveCredential: async () => "pool-token",
      });
      const { server } = app({ sync, service: poolService(type) });

      await request(server)
        .post(base)
        .send({ type, name: "Pool", key: KEY_VALUE, baseUrl: "http://pool.test:9000" })
        .expect(201);
      await request(server)
        .post(`${base}/provider-1/models`)
        .send({ models: [{ modelName: "model-a", enabled: false }, { modelName: "model-b", enabled: true }] })
        .expect(200);
      await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(200);
      await request(server).delete(`${base}/provider-1`).expect(204);

      expectNoGatewayWrite(port);
    });
  }

  it("removing a pool provider skips the gateway step and the allowlist check", async () => {
    const sync = fakeSync();
    const { server, refresh } = app({ sync, service: poolService("antigravity-pool") });

    await request(server).delete(`${base}/provider-1`).expect(204);

    expect(sync.unregisterProviderModels).not.toHaveBeenCalled();
    expect(sync.unregisterModels).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("removing a gateway-owned provider deletes only the deployments with its own api_base", async () => {
    // The real route, sync service and LiteLLM client over a fake admin API.
    const deleted: string[] = [];
    const deployment = (id: string, apiBase: string, extra: Record<string, unknown> = {}) => ({
      model_name: "openai/model-a",
      litellm_params: { model: "openai/model-a", api_base: apiBase },
      model_info: { id, ...extra },
    });
    const gateway = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/model/info")) {
        return new Response(
          JSON.stringify({
            data: [
              deployment("own", "https://api.openai.com/v1"),
              deployment("other-provider", "https://other.example.invalid/v1"),
              deployment("pool-router", "http://pool-router:4000"),
              deployment("config-file", "https://api.openai.com/v1", { db_model: false }),
            ],
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(gateway as never);
    try {
      const sync = createLitellmSyncService({
        db: scriptedDb([]),
        litellm: createLitellmSyncClient({ litellmBaseUrl: "http://gw.invalid", litellmAdminKey: "k" }),
      });
      const { server, refresh } = app({ sync });

      await request(server).delete(`${base}/provider-1`).expect(204);

      expect(deleted).toEqual(["own"]);
      expect(refresh).toHaveBeenCalledWith(COMPANY_ID);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
