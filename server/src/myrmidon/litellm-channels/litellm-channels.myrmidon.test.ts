// server/src/myrmidon/litellm-channels/litellm-channels.myrmidon.test.ts
//
// myrmidon(1.6.7 OPE-9854): LiteLLM channel management acceptance tests.
// Covers:
// - Mock tests verifying HTTP methods, paths, and payload bodies for /model/new, /model/update, /model/delete, /model/info
// - Error handling: LiteLLM errors and connection failures are transformed for UI presentation
// - Authorization: non-owner/admin actors (viewers, members, agents) are forbidden (403)
// - State: channel order changes are saved and preserved

import { createServer, type Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { createLitellmChannelsClient } from "./client.js";
import { litellmChannelsRoutes } from "./routes.js";
import { createLitellmChannelsService } from "./service.js";
import type { LitellmChannelView, LitellmChannelsPort } from "./types.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

function boardActor(userId: string, companyId: string, role: string | null, isInstanceAdmin = false) {
  return {
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin,
    companyIds: role ? [companyId] : [],
    memberships: role ? [{ companyId, membershipRole: role, status: "active" }] : [],
  };
}

const actors: Record<string, unknown> = {
  admin: boardActor("user-admin", COMPANY_A, "admin"),
  owner: boardActor("user-owner", COMPANY_A, "owner"),
  member: boardActor("user-member", COMPANY_A, "member"),
  viewer: boardActor("user-viewer", COMPANY_A, "viewer"),
  instanceAdmin: boardActor("user-instance", COMPANY_A, null, true),
  otherCompanyAdmin: boardActor("user-other", COMPANY_B, "admin"),
  agent: { type: "agent", source: "agent_key", agentId: "agent-1", companyId: COMPANY_A, keyId: "key-1" },
};

describe("LiteLLM Channels Client & Mock Transport (OPE-9854)", () => {
  let server: Server | null = null;
  const requests: Array<{
    method: string;
    path: string;
    auth: string | undefined;
    body: Record<string, any>;
  }> = [];

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    requests.length = 0;
  });

  async function startMockGateway(handler?: (reqUrl: string, body: any) => { status?: number; data: any }) {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const parsedBody = raw ? JSON.parse(raw) : {};
        requests.push({
          method: req.method ?? "GET",
          path: req.url ?? "",
          auth: req.headers.authorization,
          body: parsedBody,
        });

        if (handler) {
          const result = handler(req.url ?? "", parsedBody);
          res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.data));
          return;
        }

        if (req.url === "/model/new") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            message: "Model added",
            data: {
              model_name: parsedBody.model_name,
              litellm_params: parsedBody.litellm_params,
              model_info: {
                id: parsedBody.model_info?.id || "gen-id-1",
                ...parsedBody.model_info,
              },
            },
          }));
          return;
        }

        if (req.url === "/model/update") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            message: "Model updated",
            data: {
              model_name: parsedBody.model_name || "test-model",
              litellm_params: parsedBody.litellm_params || {},
              model_info: parsedBody.model_info || {},
            },
          }));
          return;
        }

        if (req.url === "/model/delete") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "Model deleted" }));
          return;
        }

        if (req.url === "/model/info") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            data: [
              {
                model_name: "gpt-4o",
                litellm_params: {
                  model: "openai/gpt-4o",
                  provider: "openai",
                  api_base: "https://api.openai.com/v1",
                  api_key: "secrets/openai-key",
                },
                model_info: {
                  id: "deploy-openai-1",
                  order: 1,
                  priority: 1,
                  weight: 10,
                  disabled: false,
                },
              },
              {
                model_name: "gpt-4o",
                litellm_params: {
                  model: "azure/gpt-4o-east",
                  provider: "azure",
                  api_base: "https://my-azure.openai.azure.com",
                  api_key: "secrets/azure-key",
                },
                model_info: {
                  id: "deploy-azure-2",
                  order: 2,
                  priority: 2,
                  weight: 5,
                  disabled: true,
                },
              },
            ],
          }));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  it("verifies HTTP methods and bodies for addChannel (/model/new)", async () => {
    const baseUrl = await startMockGateway();
    const client = createLitellmChannelsClient({
      litellmBaseUrl: baseUrl,
      litellmAdminKey: "test-admin-key",
    });

    const result = await client.addChannel({
      channelId: "chan-primary",
      modelName: "gpt-4o",
      providerModel: "openai/gpt-4o",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      credentialSecretName: "openai-secret",
      order: 1,
      weight: 10,
      disabled: false,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.path).toBe("/model/new");
    expect(requests[0]!.auth).toBe("Bearer test-admin-key");
    expect(requests[0]!.body).toMatchObject({
      model_name: "gpt-4o",
      litellm_params: {
        model: "openai/gpt-4o",
        provider: "openai",
        api_base: "https://api.openai.com/v1",
        api_key: "secrets/openai-secret",
        order: 1,
        weight: 10,
        disabled: false,
      },
      model_info: {
        id: "chan-primary",
        order: 1,
        priority: 1,
        weight: 10,
        disabled: false,
      },
    });

    expect(result.id).toBe("chan-primary");
    expect(result.modelName).toBe("gpt-4o");
    expect(result.order).toBe(1);
    expect(result.weight).toBe(10);
    expect(result.disabled).toBe(false);
  });

  it("verifies HTTP methods and bodies for updateChannel (/model/update)", async () => {
    const baseUrl = await startMockGateway();
    const client = createLitellmChannelsClient({
      litellmBaseUrl: baseUrl,
      litellmAdminKey: "test-admin-key",
    });

    const result = await client.updateChannel({
      channelId: "chan-primary",
      order: 3,
      weight: 25,
      disabled: false,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.path).toBe("/model/update");
    expect(requests[0]!.auth).toBe("Bearer test-admin-key");
    expect(requests[0]!.body).toMatchObject({
      model_info: {
        id: "chan-primary",
        order: 3,
        priority: 3,
        weight: 25,
        disabled: false,
      },
    });

    expect(result.id).toBe("chan-primary");
    expect(result.order).toBe(3);
    expect(result.weight).toBe(25);
  });

  it("verifies HTTP methods and bodies for disableChannel (/model/update)", async () => {
    const baseUrl = await startMockGateway();
    const client = createLitellmChannelsClient({
      litellmBaseUrl: baseUrl,
      litellmAdminKey: "test-admin-key",
    });

    const result = await client.disableChannel("chan-primary");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.path).toBe("/model/update");
    expect(requests[0]!.body).toMatchObject({
      model_info: {
        id: "chan-primary",
        disabled: true,
      },
    });
    expect(result.disabled).toBe(true);
  });

  it("verifies HTTP methods and bodies for enableChannel (/model/update)", async () => {
    const baseUrl = await startMockGateway();
    const client = createLitellmChannelsClient({
      litellmBaseUrl: baseUrl,
      litellmAdminKey: "test-admin-key",
    });

    const result = await client.enableChannel("chan-primary");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.path).toBe("/model/update");
    expect(requests[0]!.body).toMatchObject({
      model_info: {
        id: "chan-primary",
        disabled: false,
      },
    });
    expect(result.disabled).toBe(false);
  });

  it("verifies HTTP methods and bodies for deleteChannel (/model/delete)", async () => {
    const baseUrl = await startMockGateway();
    const client = createLitellmChannelsClient({
      litellmBaseUrl: baseUrl,
      litellmAdminKey: "test-admin-key",
    });

    await client.deleteChannel("chan-primary");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.path).toBe("/model/delete");
    expect(requests[0]!.body).toEqual({ id: "chan-primary" });
  });

  it("verifies HTTP methods and parsing for listChannels (/model/info)", async () => {
    const baseUrl = await startMockGateway();
    const client = createLitellmChannelsClient({
      litellmBaseUrl: baseUrl,
      litellmAdminKey: "test-admin-key",
    });

    const channels = await client.listChannels();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.path).toBe("/model/info");

    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({
      id: "deploy-openai-1",
      modelName: "gpt-4o",
      providerModel: "openai/gpt-4o",
      providerType: "openai",
      credentialSecretName: "openai-key",
      order: 1,
      weight: 10,
      disabled: false,
    });
    expect(channels[1]).toMatchObject({
      id: "deploy-azure-2",
      modelName: "gpt-4o",
      providerModel: "azure/gpt-4o-east",
      providerType: "azure",
      credentialSecretName: "azure-key",
      order: 2,
      weight: 5,
      disabled: true,
    });
  });

  it("изменение order сохраняется across updates and reorders", async () => {
    const inMemoryChannels: LitellmChannelView[] = [
      {
        id: "ch-1",
        modelName: "claude-3-5-sonnet",
        providerModel: "anthropic/claude-3-5-sonnet",
        providerType: "anthropic",
        baseUrl: null,
        credentialSecretName: "anthropic-key",
        order: 1,
        weight: 10,
        disabled: false,
      },
      {
        id: "ch-2",
        modelName: "claude-3-5-sonnet",
        providerModel: "bedrock/anthropic.claude-3-5-sonnet",
        providerType: "bedrock",
        baseUrl: null,
        credentialSecretName: "aws-key",
        order: 2,
        weight: 5,
        disabled: false,
      },
    ];

    const baseUrl = await startMockGateway((path, body) => {
      if (path === "/model/info") {
        return {
          status: 200,
          data: {
            data: inMemoryChannels.map((c) => ({
              model_name: c.modelName,
              litellm_params: {
                model: c.providerModel,
                provider: c.providerType,
                api_key: `secrets/${c.credentialSecretName}`,
              },
              model_info: {
                id: c.id,
                order: c.order,
                weight: c.weight,
                disabled: c.disabled,
              },
            })),
          },
        };
      }
      if (path === "/model/update") {
        const id = body.model_info?.id;
        const target = inMemoryChannels.find((c) => c.id === id);
        if (target) {
          if (body.model_info.order !== undefined) target.order = body.model_info.order;
          if (body.model_info.weight !== undefined) target.weight = body.model_info.weight;
          if (body.model_info.disabled !== undefined) target.disabled = body.model_info.disabled;
        }
        return {
          status: 200,
          data: {
            data: {
              model_name: target?.modelName,
              model_info: target ? { id: target.id, order: target.order, weight: target.weight } : {},
            },
          },
        };
      }
      return { status: 404, data: {} };
    });

    const client = createLitellmChannelsClient({
      litellmBaseUrl: baseUrl,
      litellmAdminKey: "test-admin-key",
    });

    // Initial state: ch-1 has order 1, ch-2 has order 2
    let current = await client.listChannels();
    expect(current.find((c) => c.id === "ch-1")?.order).toBe(1);
    expect(current.find((c) => c.id === "ch-2")?.order).toBe(2);

    // Swap order via reorderChannels
    await client.reorderChannels([
      { channelId: "ch-1", order: 2 },
      { channelId: "ch-2", order: 1 },
    ]);

    // Subsequent list confirms order is saved and reflected
    current = await client.listChannels();
    expect(current.find((c) => c.id === "ch-1")?.order).toBe(2);
    expect(current.find((c) => c.id === "ch-2")?.order).toBe(1);
  });

  it("ошибки показаны UI: transforms LiteLLM error response into actionable error", async () => {
    const baseUrl = await startMockGateway((path) => {
      if (path === "/model/new") {
        return {
          status: 400,
          data: {
            error: {
              message: "Unsupported model provider 'invalid_provider' in litellm_params",
            },
          },
        };
      }
      return { status: 200, data: {} };
    });

    const client = createLitellmChannelsClient({
      litellmBaseUrl: baseUrl,
      litellmAdminKey: "test-admin-key",
    });

    await expect(
      client.addChannel({
        modelName: "my-model",
        providerModel: "invalid_provider/my-model",
      }),
    ).rejects.toThrow(/Unsupported model provider 'invalid_provider'/);
  });

  it("ошибки показаны UI: handles network connection failure with 502 Bad Gateway", async () => {
    // Port 1 is not running anything, causing connection refused
    const client = createLitellmChannelsClient({
      litellmBaseUrl: "http://127.0.0.1:1",
      litellmAdminKey: "test-admin-key",
    });

    await expect(client.listChannels()).rejects.toThrow(/Failed to connect to LiteLLM/);
  });
});

describe("LiteLLM Channels Express Routes & Authorization (OPE-9854)", () => {
  function makeApp(portMock: Partial<LitellmChannelsPort> = {}) {
    const inMemoryChannels: LitellmChannelView[] = [
      {
        id: "chan-1",
        modelName: "gpt-4o",
        providerModel: "openai/gpt-4o",
        providerType: "openai",
        baseUrl: null,
        credentialSecretName: "secret-1",
        order: 1,
        weight: 10,
        disabled: false,
      },
    ];

    const fakePort: LitellmChannelsPort = {
      async listChannels() {
        return inMemoryChannels;
      },
      async addChannel(input) {
        const item: LitellmChannelView = {
          id: input.channelId || `chan-${Date.now()}`,
          modelName: input.modelName,
          providerModel: input.providerModel || input.modelName,
          providerType: input.providerType ?? null,
          baseUrl: input.baseUrl ?? null,
          credentialSecretName: input.credentialSecretName ?? null,
          order: input.order ?? 0,
          weight: input.weight ?? 1,
          disabled: Boolean(input.disabled),
        };
        inMemoryChannels.push(item);
        return item;
      },
      async updateChannel(input) {
        const item = inMemoryChannels.find((c) => c.id === input.channelId);
        if (!item) throw new Error("Channel not found");
        if (input.order !== undefined) item.order = input.order;
        if (input.weight !== undefined) item.weight = input.weight;
        if (input.disabled !== undefined) item.disabled = input.disabled;
        return item;
      },
      async disableChannel(channelId) {
        return this.updateChannel({ channelId, disabled: true });
      },
      async enableChannel(channelId) {
        return this.updateChannel({ channelId, disabled: false });
      },
      async deleteChannel(channelId) {
        const index = inMemoryChannels.findIndex((c) => c.id === channelId);
        if (index >= 0) inMemoryChannels.splice(index, 1);
      },
      async reorderChannels(orders) {
        for (const o of orders) {
          const item = inMemoryChannels.find((c) => c.id === o.channelId);
          if (item) item.order = o.order;
        }
        return inMemoryChannels;
      },
      ...portMock,
    };

    const service = createLitellmChannelsService({
      db: {} as any,
      readSecretValue: async () => "dummy-admin-key",
      resolvePort: async () => fakePort,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const actorKey = req.header("x-test-actor");
      if (actorKey && actors[actorKey]) {
        (req as any).actor = actors[actorKey];
      }
      next();
    });
    app.use(litellmChannelsRoutes(service));
    app.use(errorHandler);

    return { app, fakePort, inMemoryChannels };
  }

  it("запрет не-owner/admin: non-owner/admin actors cannot add channels (403)", async () => {
    const { app } = makeApp();

    // Member gets 403
    const memberRes = await request(app)
      .post(`/myrmidon/companies/${COMPANY_A}/litellm/channels`)
      .set("x-test-actor", "member")
      .send({
        modelName: "gpt-4o",
        providerModel: "openai/gpt-4o",
      });
    expect(memberRes.status).toBe(403);

    // Viewer gets 403
    const viewerRes = await request(app)
      .post(`/myrmidon/companies/${COMPANY_A}/litellm/channels`)
      .set("x-test-actor", "viewer")
      .send({
        modelName: "gpt-4o",
        providerModel: "openai/gpt-4o",
      });
    expect(viewerRes.status).toBe(403);

    // Agent gets 403
    const agentRes = await request(app)
      .post(`/myrmidon/companies/${COMPANY_A}/litellm/channels`)
      .set("x-test-actor", "agent")
      .send({
        modelName: "gpt-4o",
        providerModel: "openai/gpt-4o",
      });
    expect(agentRes.status).toBe(403);

    // Other company admin gets 403
    const otherRes = await request(app)
      .post(`/myrmidon/companies/${COMPANY_A}/litellm/channels`)
      .set("x-test-actor", "otherCompanyAdmin")
      .send({
        modelName: "gpt-4o",
        providerModel: "openai/gpt-4o",
      });
    expect(otherRes.status).toBe(403);
  });

  it("owner and admin can successfully add, update, reorder, disable and delete channels", async () => {
    const { app } = makeApp();

    // Admin creates channel -> 201
    const createRes = await request(app)
      .post(`/myrmidon/companies/${COMPANY_A}/litellm/channels`)
      .set("x-test-actor", "admin")
      .send({
        channelId: "chan-test-1",
        modelName: "claude-3-5",
        providerModel: "anthropic/claude-3-5-sonnet",
        order: 5,
        weight: 20,
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.channel.id).toBe("chan-test-1");
    expect(createRes.body.channel.order).toBe(5);

    // Owner updates channel -> 200
    const updateRes = await request(app)
      .patch(`/myrmidon/companies/${COMPANY_A}/litellm/channels/chan-test-1`)
      .set("x-test-actor", "owner")
      .send({
        order: 2,
        weight: 15,
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.channel.order).toBe(2);
    expect(updateRes.body.channel.weight).toBe(15);

    // Admin disables channel -> 200
    const disableRes = await request(app)
      .post(`/myrmidon/companies/${COMPANY_A}/litellm/channels/chan-test-1/disable`)
      .set("x-test-actor", "admin");
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.channel.disabled).toBe(true);

    // Owner reorders channels -> 200
    const reorderRes = await request(app)
      .post(`/myrmidon/companies/${COMPANY_A}/litellm/channels/reorder`)
      .set("x-test-actor", "owner")
      .send({
        orders: [
          { channelId: "chan-1", order: 10 },
          { channelId: "chan-test-1", order: 1 },
        ],
      });
    expect(reorderRes.status).toBe(200);
    const chanTest = reorderRes.body.channels.find((c: any) => c.id === "chan-test-1");
    expect(chanTest.order).toBe(1);

    // Admin deletes channel -> 200
    const deleteRes = await request(app)
      .delete(`/myrmidon/companies/${COMPANY_A}/litellm/channels/chan-test-1`)
      .set("x-test-actor", "admin");
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
  });

  it("members can read channels but cannot mutate (GET 200, mutations 403)", async () => {
    const { app } = makeApp();

    const readRes = await request(app)
      .get(`/myrmidon/companies/${COMPANY_A}/litellm/channels`)
      .set("x-test-actor", "member");
    expect(readRes.status).toBe(200);
    expect(readRes.body.channels).toHaveLength(1);

    const deleteRes = await request(app)
      .delete(`/myrmidon/companies/${COMPANY_A}/litellm/channels/chan-1`)
      .set("x-test-actor", "member");
    expect(deleteRes.status).toBe(403);
  });

  it("validation: rejects invalid inputs with clear 400 Bad Request messages", async () => {
    const { app } = makeApp();

    const missingModel = await request(app)
      .post(`/myrmidon/companies/${COMPANY_A}/litellm/channels`)
      .set("x-test-actor", "admin")
      .send({
        modelName: "",
        providerModel: "openai/gpt-4o",
      });
    expect(missingModel.status).toBe(400);
    expect(missingModel.body.error).toMatch(/modelName is required/);

    const negativeOrder = await request(app)
      .patch(`/myrmidon/companies/${COMPANY_A}/litellm/channels/chan-1`)
      .set("x-test-actor", "admin")
      .send({
        order: -1,
      });
    expect(negativeOrder.status).toBe(400);
    expect(negativeOrder.body.error).toMatch(/order must be a non-negative number/);
  });
});
