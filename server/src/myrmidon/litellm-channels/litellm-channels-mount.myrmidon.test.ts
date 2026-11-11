// server/src/myrmidon/litellm-channels/litellm-channels-mount.myrmidon.test.ts
//
// myrmidon(1.6.7 LITELLM-BOARD): the channel list the board serves.
//
// app.ts mounts the model-provider routes BEFORE the gateway-channel routes, so
// a handler for `/litellm/channels` in the provider router answers first and
// hides the gateway deployments (it used to answer {channels: [], enabled:
// false}). The routers are mounted here in the same order as app.ts.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { modelProviderRoutes } from "../model-providers/routes.js";
import { modelProviderRoutesWithSync } from "../model-providers/routes-with-sync.js";
import type { ModelProviderService } from "../model-providers/service.js";
import { litellmChannelsRoutes } from "./routes.js";
import { createLitellmChannelsService } from "./service.js";
import type { LitellmChannelView, LitellmChannelsPort } from "./types.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const admin = {
  type: "board",
  source: "session",
  userId: "user-admin",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, membershipRole: "admin", status: "active" }],
};

const deployment: LitellmChannelView = {
  id: "deployment-1",
  modelName: "zai-glm-5.3",
  providerModel: "hosted_vllm/glm-5.3",
  providerType: null,
  baseUrl: "https://gateway-upstream.test/v1",
  credentialSecretName: null,
  order: 1,
  weight: 1,
  disabled: false,
};

const fakePort = { listChannels: vi.fn(async () => [deployment]) } as unknown as LitellmChannelsPort;

/** The provider routers carry the model groups; they need no service to answer a path they do not own. */
const noService = {} as ModelProviderService;

function appWith(mountProviders: (api: express.Router) => void) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = admin;
    next();
  });
  // One `api` router, mounted in the order app.ts uses: model providers first,
  // gateway channels after.
  const api = express.Router();
  mountProviders(api);
  api.use(
    litellmChannelsRoutes(
      createLitellmChannelsService({
        db: {} as never,
        readSecretValue: async () => "admin-key",
        resolvePort: async () => fakePort,
      }),
    ),
  );
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

describe("myrmidon(1.6.7 LITELLM-BOARD) /litellm/channels is served by the gateway channel routes", () => {
  it("answers the gateway deployments although the model-provider routes are mounted first", async () => {
    const app = appWith((api) =>
      api.use(modelProviderRoutesWithSync({ service: noService, getLitellmSync: async () => null })),
    );

    const res = await request(app).get(`/api/myrmidon/companies/${COMPANY_ID}/litellm/channels`).expect(200);

    expect(res.body).toEqual({ channels: [deployment] });
    expect(res.body.enabled).toBeUndefined();
  });

  it("does the same for the part-A model-provider routes", async () => {
    const app = appWith((api) => api.use(modelProviderRoutes({ service: noService })));

    const res = await request(app).get(`/api/myrmidon/companies/${COMPANY_ID}/litellm/channels`).expect(200);

    expect(res.body.channels).toEqual([deployment]);
  });

  it("keeps the model-group list on the model-providers path the provider screen reads", async () => {
    const app = appWith((api) =>
      api.use(modelProviderRoutesWithSync({ service: noService, getLitellmSync: async () => null })),
    );

    const res = await request(app)
      .get(`/api/myrmidon/companies/${COMPANY_ID}/model-providers/litellm/channels`)
      .expect(200);

    expect(res.body).toMatchObject({ channels: [], enabled: false });
  });
});
