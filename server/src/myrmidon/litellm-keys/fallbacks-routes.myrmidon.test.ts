// server/src/myrmidon/litellm-keys/fallbacks-routes.myrmidon.test.ts
//
// myrmidon(1.6.7 LITELLM-BOARD): the fallback endpoints of the board
//   GET /api/myrmidon/companies/:companyId/litellm/fallbacks
//   PUT /api/myrmidon/companies/:companyId/litellm/fallbacks
// against a stub of the LiteLLM gateway. The gateway is the only place the
// topology lives: the board database handed to the routes is an empty object,
// so any attempt to read or write a topology there fails the test.

import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { errorHandler } from "../../middleware/index.js";
import type { LitellmModelView } from "../litellm-costs/litellm-costs.js";
import type { AgentGatewayKeyDeps } from "./agent-keys.js";
import { litellmKeysRoutes } from "./routes.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const ADMIN_KEY_SECRET = "gateway-admin-key";
const ADMIN_KEY_VALUE = "admin-key-value";

const actors: Record<string, unknown> = {
  admin: {
    type: "board",
    source: "session",
    userId: "user-admin",
    isInstanceAdmin: false,
    companyIds: [COMPANY_A],
    memberships: [{ companyId: COMPANY_A, membershipRole: "admin", status: "active" }],
  },
  agent: { type: "agent", source: "agent_key", agentId: "agent-1", companyId: COMPANY_A, keyId: "key-1" },
};

const FULL_ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.test",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: ADMIN_KEY_SECRET,
};

function model(
  modelName: string,
  provider: string | null,
  inputCostPerToken: number | null,
  outputCostPerToken: number | null,
): LitellmModelView {
  return {
    modelName,
    provider,
    maxInputTokens: null,
    maxOutputTokens: null,
    inputCostPerToken,
    outputCostPerToken,
    cacheReadInputTokenCost: null,
    cacheCreationInputTokenCost: null,
    seenAt: "2026-11-08T00:00:00.000Z",
  };
}

const CATALOG: LitellmModelView[] = [
  model("zai-glm-5.3", "hosted_vllm", 0.0000014, 0.0000044),
  model("zai-glm-5.3-flash", "hosted_vllm", 0.00000015, 0.0000005),
  model("kie-gpt-6-luna", "openai", null, null),
  model("deepseek-v4-flash", "deepseek", 0.00000015, 0.0000006),
];

// The board never touches a database for the topology; `{}` throws on any use.
const NO_DB = {} as Db;
const deps = {
  readSecretValue: async (_companyId: string, name: string) => (name === ADMIN_KEY_SECRET ? ADMIN_KEY_VALUE : null),
} as unknown as AgentGatewayKeyDeps;

function makeApp(env: NodeJS.ProcessEnv) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actorKey = req.header("x-test-actor");
    if (actorKey && actors[actorKey]) {
      (req as unknown as { actor: unknown }).actor = actors[actorKey];
    }
    next();
  });
  app.use(litellmKeysRoutes(NO_DB, { deps, env, listModels: async () => CATALOG }));
  app.use(errorHandler);
  return app;
}

/** A stub of the gateway that keeps `router_settings.fallbacks` the way /config/update stores it. */
function stubGateway(initial: Array<Record<string, string[]>>) {
  let fallbacks = initial;
  const calls: Array<{ method: string; path: string; auth: string | undefined; body: any }> = [];
  vi.stubGlobal("fetch", async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, auth: init?.headers?.Authorization, body: init?.body ? JSON.parse(init.body) : null });
    if (url.pathname === "/router/settings" && method === "GET") {
      return new Response(JSON.stringify({ current_values: { fallbacks } }), { status: 200 });
    }
    if (url.pathname === "/config/update" && method === "POST") {
      fallbacks = JSON.parse(init!.body!).router_settings.fallbacks;
      return new Response(JSON.stringify({ message: "Config updated successfully" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  return { calls, current: () => fallbacks };
}

describe("myrmidon(1.6.7 LITELLM-BOARD) fallback endpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET answers the live gateway topology and the model catalog", async () => {
    const gateway = stubGateway([{ "zai-glm-5.3": ["zai-glm-5.3-flash"] }]);

    const res = await request(makeApp(FULL_ENV))
      .get(`/myrmidon/companies/${COMPANY_A}/litellm/fallbacks`)
      .set("x-test-actor", "admin");

    expect(res.status).toBe(200);
    expect(res.body.chains).toEqual([{ model: "zai-glm-5.3", targets: ["zai-glm-5.3-flash"] }]);
    expect(res.body.error).toBeUndefined();
    expect(res.body.models.map((m: { modelName: string }) => m.modelName)).toContain("zai-glm-5.3-flash");
    expect(gateway.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /router/settings"]);
    expect(gateway.calls[0]!.auth).toBe(`Bearer ${ADMIN_KEY_VALUE}`);
  });

  it("PUT writes the whole list to the gateway and answers what the gateway now holds", async () => {
    const gateway = stubGateway([{ "stale-group": ["stale-target"] }]);
    const chains = [
      { model: "zai-glm-5.3", targets: ["zai-glm-5.3-flash"] },
      { model: "zai-glm-5.3-flash", targets: ["kie-gpt-6-luna"] },
    ];

    const res = await request(makeApp(FULL_ENV))
      .put(`/myrmidon/companies/${COMPANY_A}/litellm/fallbacks`)
      .set("x-test-actor", "admin")
      .send({ chains });

    expect(res.status).toBe(200);
    expect(gateway.current()).toEqual([{ "zai-glm-5.3": ["zai-glm-5.3-flash"] }, { "zai-glm-5.3-flash": ["kie-gpt-6-luna"] }]);
    expect(res.body.chains).toEqual(chains);
    // The gateway was written with POST /config/update, then read back; nothing else was called.
    expect(gateway.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /config/update", "GET /router/settings"]);
    expect(gateway.calls[0]!.body).toEqual({
      router_settings: { fallbacks: [{ "zai-glm-5.3": ["zai-glm-5.3-flash"] }, { "zai-glm-5.3-flash": ["kie-gpt-6-luna"] }] },
    });
  });

  it("PUT allows a fallback inside one provider and returns it as a warning", async () => {
    stubGateway([]);

    const res = await request(makeApp(FULL_ENV))
      .put(`/myrmidon/companies/${COMPANY_A}/litellm/fallbacks`)
      .set("x-test-actor", "admin")
      .send({ chains: [{ model: "zai-glm-5.3", targets: ["zai-glm-5.3-flash"] }] });

    expect(res.status).toBe(200);
    expect(res.body.chains).toEqual([{ model: "zai-glm-5.3", targets: ["zai-glm-5.3-flash"] }]);
    expect(res.body.warnings).toHaveLength(2);
    expect(res.body.warnings.join(" ")).toMatch(/hosted_vllm/);
  });

  it("PUT refuses a target the catalog does not know, with a clear 422, and writes nothing", async () => {
    const gateway = stubGateway([]);

    const res = await request(makeApp(FULL_ENV))
      .put(`/myrmidon/companies/${COMPANY_A}/litellm/fallbacks`)
      .set("x-test-actor", "admin")
      .send({ chains: [{ model: "zai-glm-5.3", targets: ["no-such-model"] }] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("litellm_unknown_model_groups");
    expect(res.body.error).toContain("no-such-model");
    expect(gateway.calls).toEqual([]);
  });

  it("PUT refuses a body without a list of chains instead of clearing the gateway's list", async () => {
    const gateway = stubGateway([{ "zai-glm-5.3": ["zai-glm-5.3-flash"] }]);
    const app = makeApp(FULL_ENV);

    const noBody = await request(app)
      .put(`/myrmidon/companies/${COMPANY_A}/litellm/fallbacks`)
      .set("x-test-actor", "admin");
    const wrongShape = await request(app)
      .put(`/myrmidon/companies/${COMPANY_A}/litellm/fallbacks`)
      .set("x-test-actor", "admin")
      .send({ chains: [{ model: "zai-glm-5.3", targets: "zai-glm-5.3-flash" }] });

    expect(noBody.status).toBe(400);
    expect(wrongShape.status).toBe(400);
    expect(gateway.calls).toEqual([]);
    expect(gateway.current()).toEqual([{ "zai-glm-5.3": ["zai-glm-5.3-flash"] }]);
  });

  it("PUT is for the board only: an agent key is refused", async () => {
    const gateway = stubGateway([]);

    const res = await request(makeApp(FULL_ENV))
      .put(`/myrmidon/companies/${COMPANY_A}/litellm/fallbacks`)
      .set("x-test-actor", "agent")
      .send({ chains: [] });

    expect(res.status).toBe(403);
    expect(gateway.calls).toEqual([]);
  });

  it("answers 503 litellm_gateway_not_configured and names both missing variables", async () => {
    const app = makeApp({});

    const put = await request(app)
      .put(`/myrmidon/companies/${COMPANY_A}/litellm/fallbacks`)
      .set("x-test-actor", "admin")
      .send({ chains: [] });
    const get = await request(app)
      .get(`/myrmidon/companies/${COMPANY_A}/litellm/fallbacks`)
      .set("x-test-actor", "admin");

    for (const res of [put, get]) {
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("litellm_gateway_not_configured");
      expect(res.body.enabled).toBe(false);
      expect(res.body.missing).toEqual(["MYRMIDON_LITELLM_BASE_URL", "MYRMIDON_LITELLM_ADMIN_KEY_SECRET"]);
      expect(res.body.error).toContain("MYRMIDON_LITELLM_ADMIN_KEY_SECRET");
    }
  });

  it("names only the variable that is missing", async () => {
    const res = await request(makeApp({ MYRMIDON_LITELLM_BASE_URL: "http://gateway.test" }))
      .put(`/myrmidon/companies/${COMPANY_A}/litellm/fallbacks`)
      .set("x-test-actor", "admin")
      .send({ chains: [] });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("litellm_gateway_not_configured");
    expect(res.body.missing).toEqual(["MYRMIDON_LITELLM_ADMIN_KEY_SECRET"]);
  });
});
