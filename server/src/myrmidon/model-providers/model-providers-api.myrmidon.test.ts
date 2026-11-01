// server/src/myrmidon/model-providers/model-providers-api.myrmidon.test.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS A): the settings API — access rules,
// request parsing, and that no response ever carries the key value.
//
// Plain fakes for the service: no database, no network. The service's own
// suite (model-providers.db.myrmidon.test.ts) covers the store against a
// real database.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearModelProviderConnectors,
  DEFAULT_CHATGPT_POOL_MODELS,
  isModelProviderTypeAvailable,
  listAvailableModelProviderTypes,
  registerModelProviderConnector,
  unregisterModelProviderConnector,
} from "@myrmidon/shared";
import { badRequest } from "../../errors.js";
import { errorHandler } from "../../middleware/index.js";
import { modelProviderRoutes } from "./routes.js";
import type { ModelProviderService, ModelProviderView } from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "33333333-3333-4333-8333-333333333333";

const KEY_VALUE = "sk-test-provider-key-value-1234";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "admin", status: "active" }],
};
const ownerActor = {
  type: "board",
  source: "session",
  userId: "user-owner",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "owner", status: "active" }],
};
const plainMember = {
  type: "board",
  source: "session",
  userId: "user-plain",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
};
const operatorMember = {
  type: "board",
  source: "session",
  userId: "user-operator",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "operator", status: "active" }],
};
const viewerMember = {
  type: "board",
  source: "session",
  userId: "user-viewer",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "viewer", status: "active" }],
};
const instanceAdminActor = {
  type: "board",
  source: "session",
  userId: "user-ia",
  isInstanceAdmin: true,
  companyIds: [COMPANY_ID],
};
const outsider = {
  type: "board",
  source: "session",
  userId: "user-b",
  isInstanceAdmin: false,
  companyIds: [OTHER_COMPANY],
  memberships: [{ companyId: OTHER_COMPANY, membershipRole: "admin", status: "active" }],
};
const agentActor = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: COMPANY_ID, keyId: "key-a" };

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

/** A fake service that records what the routes asked it to do. */
function fakeService() {
  const calls: Array<{ op: string; companyId: string; providerId?: string; body?: unknown }> = [];
  const service: ModelProviderService = {
    async createProvider(input) {
      if (!isModelProviderTypeAvailable(input.body.type)) {
        throw badRequest(
          `provider type "${input.body.type}" is not available; connector plugin is not registered`,
          { code: "model_provider_type_unsupported" },
        );
      }
      calls.push({ op: "create", companyId: input.companyId, body: input.body });
      await input.activity?.({
        companyId: input.companyId,
        action: "model_provider_added",
        providerId: "provider-1",
        details: {},
      });
      return { ...providerView("provider-1"), type: input.body.type, name: input.body.name };
    },
    async rotateProviderKey(input) {
      calls.push({ op: "rotate", companyId: input.companyId, providerId: input.providerId, body: input.key });
      await input.activity?.({
        companyId: input.companyId,
        action: "model_provider_key_rotated",
        providerId: input.providerId,
        details: {},
      });
      return providerView(input.providerId);
    },
    async patchProvider(input) {
      calls.push({ op: "patch", companyId: input.companyId, providerId: input.providerId, body: input.body });
      return providerView(input.providerId);
    },
    async removeProvider(input) {
      calls.push({ op: "remove", companyId: input.companyId, providerId: input.providerId });
      await input.activity?.({
        companyId: input.companyId,
        action: "model_provider_removed",
        providerId: input.providerId,
        details: {},
      });
    },
    async listProviders(companyId) {
      calls.push({ op: "list", companyId });
      return [providerView("provider-1")];
    },
    async readProvider(companyId, providerId) {
      calls.push({ op: "read", companyId, providerId });
      return providerView(providerId);
    },
    async listModels(companyId, providerId) {
      calls.push({ op: "listModels", companyId, providerId });
      return [
        { id: "m1", modelName: "model-a", litellmModelName: "openai/model-a", enabled: true, free: false },
        { id: "m2", modelName: "model-b", litellmModelName: "openai/model-b", enabled: true, free: false },
      ];
    },
    async setModels(input) {
      calls.push({ op: "setModels", companyId: input.companyId, providerId: input.providerId, body: input.models });
      return [
        { id: "m1", modelName: "model-a", litellmModelName: "openai/model-a", enabled: false, free: true },
      ];
    },
    async checkToolCallCompatibility(input) {
      calls.push({ op: "checkToolCallCompatibility", companyId: input.companyId, providerId: input.providerId });
      return providerView(input.providerId);
    },
    async listChannels(companyId, providerId) {
      calls.push({ op: "listChannels", companyId, providerId });
      return {
        providerId,
        providerType: "chatgpt-pool",
        channels: [
          {
            n: 1,
            label: "account-1",
            email: "acc1@example.com",
            state: "active",
            stateRu: "Активен",
            plan: "plus",
            limitedUntil: null,
            lastOk: 1700000000,
            windows: {
              primary: { usedPct: 20, windowMin: 300, resetsAt: 1700018000 },
              secondary: { usedPct: 15, windowMin: 10080, resetsAt: 1700600000 },
            },
            isBanned: false,
            isExhausted: false,
          },
        ],
        signals: [],
      };
    },
    listAvailableTypes: () => listAvailableModelProviderTypes(),
    syncPoolSignals: async () => [],
  };
  return { service, calls };
}

function app(actor: unknown, options: { service?: ModelProviderService } = {}) {
  const fake = fakeService();
  const service = options.service ?? fake.service;
  const activity: Array<{ action: string; providerId: string; companyId: string }> = [];
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    modelProviderRoutes({
      service,
      recordActivity: async (entry) => {
        activity.push({ action: entry.action, providerId: entry.providerId, companyId: entry.companyId });
      },
    }),
  );
  server.use(errorHandler);
  return { server, calls: fake.calls, activity };
}

const base = `/api/myrmidon/companies/${COMPANY_ID}/model-providers`;

describe("myrmidon(1.6.1 MODEL-PROVIDERS, 1.6.7 OPE-9852) routes: access", () => {
  it("denies another company on every route (403, no service call)", async () => {
    const { server, calls } = app(outsider);
    await request(server).get(base).expect(403);
    await request(server).post(base).send({ type: "openai", name: "p", key: KEY_VALUE }).expect(403);
    await request(server).patch(`${base}/provider-1`).send({ free: true }).expect(403);
    await request(server).delete(`${base}/provider-1`).expect(403);
    await request(server).get(`${base}/provider-1/models`).expect(403);
    await request(server).post(`${base}/provider-1/models`).send({ models: [] }).expect(403);
    await request(server).get(`${base}/provider-1/channels`).expect(403);
    expect(calls).toHaveLength(0);
  });

  it("denies ordinary company members, operators and viewers on every route (403, no service call)", async () => {
    for (const actor of [plainMember, operatorMember, viewerMember]) {
      const { server, calls } = app(actor);
      await request(server).get(base).expect(403);
      await request(server).get(`${base}/provider-1/models`).expect(403);
      await request(server).get(`${base}/provider-1/channels`).expect(403);
      await request(server).post(base).send({ type: "openai", name: "p", key: KEY_VALUE }).expect(403);
      await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(403);
      await request(server).delete(`${base}/provider-1`).expect(403);
      await request(server).post(`${base}/provider-1/models`).send({ models: [] }).expect(403);
      expect(calls).toHaveLength(0);
    }
  });

  it("denies an agent actor on every route (403, no service call)", async () => {
    const { server, calls } = app(agentActor);
    await request(server).get(base).expect(403);
    await request(server).get(`${base}/provider-1/models`).expect(403);
    await request(server).get(`${base}/provider-1/channels`).expect(403);
    await request(server).post(base).send({ type: "openai", name: "p", key: KEY_VALUE }).expect(403);
    await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(403);
    await request(server).delete(`${base}/provider-1`).expect(403);
    await request(server).post(`${base}/provider-1/models`).send({ models: [] }).expect(403);
    expect(calls).toHaveLength(0);
  });

  it("lets a company admin, owner, and instance admin do everything", async () => {
    for (const actor of [member, ownerActor, instanceAdminActor]) {
      const { server } = app(actor);
      await request(server).post(base).send({ type: "openai", name: "p", key: KEY_VALUE }).expect(201);
      await request(server).get(base).expect(200);
      await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(200);
      await request(server).delete(`${base}/provider-1`).expect(204);
      await request(server).post(`${base}/provider-1/models`).send({ models: [] }).expect(200);
    }
  });
});

describe("myrmidon(1.6.1 MODEL-PROVIDERS) routes: parsing", () => {
  it("rejects an unknown provider type", async () => {
    const { server, calls } = app(member);
    const response = await request(server)
      .post(base)
      .send({ type: "anthropic", name: "x", key: KEY_VALUE })
      .expect(400);
    expect(response.body.error).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("rejects a create without a key", async () => {
    const { server, calls } = app(member);
    await request(server).post(base).send({ type: "openai", name: "x" }).expect(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a create with a non-URL baseUrl", async () => {
    const { server, calls } = app(member);
    await request(server)
      .post(base)
      .send({ type: "openai", name: "x", key: KEY_VALUE, baseUrl: "not-a-url" })
      .expect(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects an openai-compatible provider without baseUrl", async () => {
    const { server, calls } = app(member);
    await request(server)
      .post(base)
      .send({ type: "openai-compatible", name: "x", key: KEY_VALUE })
      .expect(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects a models update with an unknown shape", async () => {
    const { server, calls } = app(member);
    await request(server).post(`${base}/provider-1/models`).send({ models: "all" }).expect(400);
    expect(calls).toHaveLength(0);
  });
});

describe("myrmidon(1.6.1 MODEL-PROVIDERS) routes: the key is write-only", () => {
  it("never echoes the key value in any response body", async () => {
    const { server } = app(member);
    // The request bodies carry the key; the responses must not.
    const created = await request(server)
      .post(base)
      .send({ type: "openai", name: "p", key: KEY_VALUE })
      .expect(201);
    expect(JSON.stringify(created.body)).not.toContain(KEY_VALUE);

    const listed = await request(server).get(base).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(KEY_VALUE);

    const rotated = await request(server)
      .patch(`${base}/provider-1`)
      .send({ key: KEY_VALUE })
      .expect(200);
    expect(JSON.stringify(rotated.body)).not.toContain(KEY_VALUE);

    const models = await request(server).get(`${base}/provider-1/models`).expect(200);
    expect(JSON.stringify(models.body)).not.toContain(KEY_VALUE);

    const set = await request(server)
      .post(`${base}/provider-1/models`)
      .send({ models: [{ modelName: "model-a" }] })
      .expect(200);
    expect(JSON.stringify(set.body)).not.toContain(KEY_VALUE);

    const channels = await request(server).get(`${base}/provider-1/channels`).expect(200);
    expect(JSON.stringify(channels.body)).not.toContain(KEY_VALUE);
  });

  it("never echoes the key value in an error body either", async () => {
    // A validation error names the offending field, not its value.
    const { server } = app(member);
    const response = await request(server)
      .post(base)
      .send({ type: "openai", name: KEY_VALUE, key: 12345 })
      .expect(400);
    expect(JSON.stringify(response.body)).not.toContain(KEY_VALUE);
  });
});

describe("myrmidon(1.6.1 MODEL-PROVIDERS) routes: channels and chatgpt-pool", () => {
  it("answers channels and active role signals for chatgpt-pool", async () => {
    const { server, calls } = app(member);
    const res = await request(server).get(`${base}/provider-1/channels`).expect(200);
    expect(calls.some((c) => c.op === "listChannels")).toBe(true);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].n).toBe(1);
    expect(res.body.channels[0].windows.primary.usedPct).toBe(20);
    expect(res.body.channels[0].stateRu).toBe("Активен");
  });

  it("accepts pool account status event via POST /account-status and records signal", async () => {
    const { server } = app(member);
    const res = await request(server)
      .post(`${base}/provider-1/account-status`)
      .send({
        accountNumber: 3,
        label: "Account #3",
        state: "banned",
        isBanned: true,
      })
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.signal).toBeDefined();
    expect(res.body.signal.accountNumber).toBe(3);
    expect(res.body.signal.kind).toBe("banned");
    expect(res.body.signal.severity).toBe("high");
  });
});

describe("myrmidon(1.6.1 MODEL-PROVIDERS) routes: activity", () => {
  it("forwards add, rotate and remove entries to the activity log", async () => {
    const { server, activity } = app(member);
    await request(server).post(base).send({ type: "openai", name: "p", key: KEY_VALUE }).expect(201);
    await request(server).patch(`${base}/provider-1`).send({ key: KEY_VALUE }).expect(200);
    await request(server).delete(`${base}/provider-1`).expect(204);
    expect(activity.map((a) => a.action)).toEqual([
      "model_provider_added",
      "model_provider_key_rotated",
      "model_provider_removed",
    ]);
  });
});

describe("myrmidon(1.6.1 MODEL-PROVIDERS) connector boundary & availableTypes", () => {
  afterEach(() => {
    clearModelProviderConnectors();
  });

  it("omits unregistered connectors from availableTypes and rejects provider creation", async () => {
    clearModelProviderConnectors();
    const { server, calls } = app(member);

    // GET lists available types without chatgpt-pool
    const getRes = await request(server).get(base).expect(200);
    expect(getRes.body.availableTypes).toBeDefined();
    expect(getRes.body.availableTypes).not.toContain("chatgpt-pool");
    expect(getRes.body.availableTypes).toContain("openai");
    expect(getRes.body.availableTypes).toContain("dashscope");

    // POST with unregistered type is rejected with 400 bad request
    const postRes = await request(server)
      .post(base)
      .send({ type: "chatgpt-pool", name: "Codex Pool", key: KEY_VALUE })
      .expect(400);

    expect(postRes.body.error).toContain("connector plugin is not registered");
    expect(calls.filter((c) => c.op === "create")).toHaveLength(0);
  });

  it("includes registered connector in availableTypes and allows creation", async () => {
    registerModelProviderConnector({
      type: "chatgpt-pool",
      name: "ChatGPT / Codex Subscription Pool",
      pluginKey: "myrmidon.chatgpt-pool",
      defaultModels: DEFAULT_CHATGPT_POOL_MODELS,
      supportsChannels: true,
    });

    const { server, calls } = app(member);

    // GET now includes chatgpt-pool
    const getRes = await request(server).get(base).expect(200);
    expect(getRes.body.availableTypes).toContain("chatgpt-pool");

    // POST succeeds
    const postRes = await request(server)
      .post(base)
      .send({ type: "chatgpt-pool", name: "Codex Pool", key: KEY_VALUE })
      .expect(201);

    expect(postRes.body.type).toBe("chatgpt-pool");
    expect(calls.filter((c) => c.op === "create")).toHaveLength(1);

    // Unregistering removes it again
    unregisterModelProviderConnector("chatgpt-pool");
    const getRes2 = await request(server).get(base).expect(200);
    expect(getRes2.body.availableTypes).not.toContain("chatgpt-pool");
  });
});

