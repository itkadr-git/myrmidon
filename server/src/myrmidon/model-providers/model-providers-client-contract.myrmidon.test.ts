// server/src/myrmidon/model-providers/model-providers-client-contract.myrmidon.test.ts
//
// myrmidon(1.6.7 OPE-12345): the other half of ui/src/components/myrmidon/
// model-providers/modelProvidersApi.myrmidon.test.ts. The 1.6.1 client called
// `…/model-providers/providers/…` and every call answered 404, because the
// server mounts `…/model-providers[/:id…]`. Here the REAL router answers each
// path the client calls (none is a 404), and the retired `/providers/…` forms
// stay unrouted, so a drift in either direction turns one of the two suites red.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { modelProviderRoutesWithSync } from "./routes-with-sync.js";
import type { ModelProviderService, ModelProviderView } from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const base = `/api/myrmidon/companies/${COMPANY_ID}/model-providers`;

const admin = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "admin", status: "active" }],
};

const view = {
  id: "prov-1",
  type: "openai",
  name: "OpenAI",
  baseUrl: null,
  hasKey: true,
  credentialSecretName: null,
  free: false,
  expiresAt: null,
  packageName: null,
  rpmLimit: null,
  toolCallCompatible: null,
  toolCallCheckedAt: null,
  toolCallCheckError: null,
  keyValidatedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as unknown as ModelProviderView;

function fakeService(): ModelProviderService {
  return {
    createProvider: vi.fn(async () => view),
    rotateProviderKey: vi.fn(async () => view),
    patchProvider: vi.fn(async () => view),
    removeProvider: vi.fn(async () => undefined),
    listProviders: vi.fn(async () => [view]),
    readProvider: vi.fn(async () => view),
    listModels: vi.fn(async () => []),
    setModels: vi.fn(async () => []),
    listChannels: vi.fn(async (_companyId: string, providerId: string) => ({
      providerId,
      providerType: "openai",
      channels: [],
      signals: [],
    })),
    listAvailableTypes: () => ["openai"],
    oauthBegin: vi.fn(async () => ({ accountNumber: 1, userCode: "C", verificationUri: "u", expiresInSec: 1, intervalSec: 1 })),
    oauthStatus: vi.fn(async () => ({ accountNumber: 1, status: "pending" })),
    oauthComplete: vi.fn(async () => ({ ok: true, accountNumber: 1 })),
    oauthRefresh: vi.fn(async () => ({ ok: true, accountNumber: 1 })),
  } as unknown as ModelProviderService;
}

function server() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = admin;
    next();
  });
  app.use(
    "/api",
    modelProviderRoutesWithSync({
      service: fakeService(),
      getLitellmSync: async () => null,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("the paths modelProvidersApi calls are routed by the server", () => {
  const cases: Array<{ name: string; method: "get" | "post" | "patch" | "delete"; path: string; body?: object; status: number }> = [
    { name: "view", method: "get", path: base, status: 200 },
    { name: "add", method: "post", path: base, body: { type: "openai", name: "OpenAI", key: "k" }, status: 201 },
    { name: "rotate", method: "patch", path: `${base}/prov-1`, body: { key: "new-key" }, status: 200 },
    { name: "remove", method: "delete", path: `${base}/prov-1`, status: 204 },
    { name: "models", method: "get", path: `${base}/prov-1/models`, status: 200 },
    { name: "updateModels", method: "post", path: `${base}/prov-1/models`, body: { models: [] }, status: 200 },
    { name: "channels", method: "get", path: `${base}/prov-1/channels`, status: 200 },
    { name: "litellmChannels", method: "get", path: `${base}/litellm/channels`, status: 200 },
    { name: "oauthBegin", method: "post", path: `${base}/prov-1/oauth/begin`, body: {}, status: 200 },
    { name: "oauthStatus", method: "get", path: `${base}/prov-1/oauth/status?accountNumber=1`, status: 200 },
    { name: "oauthComplete", method: "post", path: `${base}/prov-1/oauth/complete`, body: { accountNumber: 1 }, status: 200 },
    { name: "oauthRefresh", method: "post", path: `${base}/prov-1/oauth/refresh`, body: { accountNumber: 1 }, status: 200 },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.method.toUpperCase()} ${c.path.replace(base, "…/model-providers")} answers ${c.status}`, async () => {
      let req = request(server())[c.method](c.path);
      if (c.body) req = req.send(c.body);
      await req.expect(c.status);
    });
  }

  it("the retired /providers/… forms the 1.6.1 client used are not routed (404)", async () => {
    const app = server();
    await request(app).get(`${base}/providers`).expect(404);
    await request(app).get(`${base}/providers/prov-1/models`).expect(404);
    await request(app).post(`${base}/providers/prov-1/models`).send({ models: [] }).expect(404);
    await request(app).get(`${base}/providers/prov-1/channels`).expect(404);
    await request(app).patch(`${base}/providers/prov-1`).send({ key: "new-key" }).expect(404);
  });
});
