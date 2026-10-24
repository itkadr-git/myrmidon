// myrmidon(SETTINGS-UI E2.3): the instance-scoped bot/fleet tokens as secret-ref settings.
// The store is an in-memory fake; the registry, resolver, token reader and the real
// egress and dockergate routes are production code. No database, no external network.

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { HttpError } from "../../errors.js";
import { errorHandler } from "../../middleware/index.js";
import { INSTANCE_SECRET_SETTINGS, InstanceSecretSettingRegistry } from "../secret-settings/registry.js";
import {
  createInstanceSecretSettingResolver,
  type InstanceSecretBinding,
  type InstanceSecretSettingStore,
} from "../secret-settings/resolver.js";
import {
  BOT_DISK_DOCKERGATE_CONSUMER,
  BOT_EGRESS_POLICY_CONSUMER,
  BOT_EGRESS_REFUSALS_CONSUMER,
  BOT_EGRESS_TOKEN_SETTING,
  DOCKERGATE_TOKEN_SETTING,
} from "../secret-settings/bot-fleet-settings.js";
import { createTokenReaderFromResolver } from "./instance-token-reader.js";
import { botEgressRoutes, type BotEgressStore } from "./egress-routes.js";
import { egressRefusalFeed } from "./egress-wiring.js";
import { botDiskPhysicalRoutes } from "./bot-disk-physical-routes.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const SECRET_OK = "22222222-2222-4222-8222-222222222222";
const SECRET_NEW = "33333333-3333-4333-8333-333333333333";
const REF_TOKEN = "ref-token-value-1";
const NEW_TOKEN = "ref-token-value-2";
const ENV_TOKEN = "env-emergency-token";

function makeResolver(env: NodeJS.ProcessEnv, restrictConsumersTo?: string[]) {
  const registry = new InstanceSecretSettingRegistry(
    INSTANCE_SECRET_SETTINGS.map((e) => (restrictConsumersTo ? { ...e, consumers: restrictConsumersTo } : e)),
  );
  const bindings = new Map<string, InstanceSecretBinding>();
  const secrets = new Map<string, { name: string; status: string; value: string }>([
    [SECRET_OK, { name: "egress-token", status: "active", value: REF_TOKEN }],
    [SECRET_NEW, { name: "egress-token-2", status: "active", value: NEW_TOKEN }],
  ]);
  const store: InstanceSecretSettingStore = {
    async getBinding(name) {
      return bindings.get(name) ?? null;
    },
    async resolveValue(input) {
      const secret = secrets.get(input.secretId);
      if (!secret) throw new HttpError(404, "Secret not found", { code: "secret_missing" });
      if (secret.status !== "active") throw new HttpError(422, "Secret is not active", { code: "secret_inactive" });
      return secret.value;
    },
    async describeSecret(id) {
      const s = secrets.get(id);
      return s ? { name: s.name, status: s.status, companyId: COMPANY } : null;
    },
    async setBinding(name, secretId) {
      const b = { companyId: COMPANY, secretId };
      bindings.set(name, b);
      return b;
    },
    async clearBinding(name) {
      return bindings.delete(name);
    },
  };
  const redacted: string[] = [];
  const resolver = createInstanceSecretSettingResolver({
    registry,
    store,
    env,
    registerForRedaction: (v) => redacted.push(v),
  });
  return { resolver, secrets, redacted };
}

const emptyStore: BotEgressStore = {
  async list() {
    return [];
  },
  async listAll() {
    return [];
  },
  async upsertProject() {},
  async upsertBot() {},
  async projectNames() {
    return new Map();
  },
  async hasProject() {
    return false;
  },
};

function egressApp(resolver: ReturnType<typeof makeResolver>["resolver"]) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    botEgressRoutes({
      store: emptyStore,
      readRefusals: async () => [],
      env: {},
      readToken: createTokenReaderFromResolver(() => resolver, BOT_EGRESS_TOKEN_SETTING, BOT_EGRESS_POLICY_CONSUMER),
    }),
  );
  app.use(errorHandler);
  return app;
}

const policyUrl = "/api/myrmidon/bot-egress/policy";

describe("registration", () => {
  it("registers the egress and dockergate tokens with their env variables as emergency overrides", () => {
    const egress = INSTANCE_SECRET_SETTINGS.find((e) => e.name === BOT_EGRESS_TOKEN_SETTING);
    const gate = INSTANCE_SECRET_SETTINGS.find((e) => e.name === DOCKERGATE_TOKEN_SETTING);
    expect(egress?.envOverride).toBe("MYRMIDON_BOT_EGRESS_TOKEN");
    expect(egress?.consumers).toEqual([BOT_EGRESS_POLICY_CONSUMER, BOT_EGRESS_REFUSALS_CONSUMER]);
    expect(gate?.envOverride).toBe("MYRMIDON_DOCKERGATE_TOKEN");
    expect(gate?.consumers).toEqual([BOT_DISK_DOCKERGATE_CONSUMER]);
  });

  it("registers no per-agent credential, no secret-name pointer and no fleet-host bootstrap token", () => {
    const overrides = INSTANCE_SECRET_SETTINGS.map((e) => e.envOverride);
    for (const name of [
      "MYRMIDON_API_KEY",
      "MYRMIDON_BOT_KEY",
      "MYRMIDON_GIT_TOKEN",
      "MYRMIDON_GITHUB_BRIDGE_TOKEN",
      "MYRMIDON_GITHUB_BROKER_TOKEN",
      "MYRMIDON_BOT_LLM_API_KEY_ENV",
      "MYRMIDON_BOT_LLM_API_KEY_SECRET",
      "MYRMIDON_LOCAL_SITE_AGENT_TOKEN_SECRET",
      "MYRMIDON_FLEET_HOST_TOKEN",
    ]) {
      expect(overrides).not.toContain(name);
    }
    expect(overrides.some((o) => o.startsWith("MYRMIDON_MCP_TOKEN_"))).toBe(false);
  });
});

describe("egress policy token", () => {
  it("accepts the bound reference token and rejects another one", async () => {
    const { resolver } = makeResolver({});
    await resolver.setRef(BOT_EGRESS_TOKEN_SETTING, SECRET_OK);
    const app = egressApp(resolver);
    await request(app).get(policyUrl).set("Authorization", `Bearer ${REF_TOKEN}`).expect(200);
    await request(app).get(policyUrl).set("Authorization", "Bearer wrong").expect(401);
  });

  it("lets the emergency env token win over the reference", async () => {
    const { resolver } = makeResolver({ MYRMIDON_BOT_EGRESS_TOKEN: ENV_TOKEN });
    await resolver.setRef(BOT_EGRESS_TOKEN_SETTING, SECRET_OK);
    const app = egressApp(resolver);
    await request(app).get(policyUrl).set("Authorization", `Bearer ${ENV_TOKEN}`).expect(200);
    await request(app).get(policyUrl).set("Authorization", `Bearer ${REF_TOKEN}`).expect(401);
  });

  it("is not published when no reference is bound, and the answer carries no value", async () => {
    const { resolver } = makeResolver({});
    const res = await request(egressApp(resolver)).get(policyUrl).set("Authorization", `Bearer ${REF_TOKEN}`).expect(503);
    expect(res.body.code).toBe("bot_egress_policy_not_published");
    expect(JSON.stringify(res.body)).not.toContain(REF_TOKEN);
  });

  it("stops publishing after the reference is cleared (revoke)", async () => {
    const { resolver } = makeResolver({});
    await resolver.setRef(BOT_EGRESS_TOKEN_SETTING, SECRET_OK);
    const app = egressApp(resolver);
    await request(app).get(policyUrl).set("Authorization", `Bearer ${REF_TOKEN}`).expect(200);
    await resolver.clearRef(BOT_EGRESS_TOKEN_SETTING);
    await request(app).get(policyUrl).set("Authorization", `Bearer ${REF_TOKEN}`).expect(503);
  });

  it("switches to the new token when the reference is replaced", async () => {
    const { resolver } = makeResolver({});
    await resolver.setRef(BOT_EGRESS_TOKEN_SETTING, SECRET_OK);
    const app = egressApp(resolver);
    await resolver.setRef(BOT_EGRESS_TOKEN_SETTING, SECRET_NEW);
    await request(app).get(policyUrl).set("Authorization", `Bearer ${NEW_TOKEN}`).expect(200);
    await request(app).get(policyUrl).set("Authorization", `Bearer ${REF_TOKEN}`).expect(401);
  });

  it("fails closed for a disabled secret", async () => {
    const { resolver, secrets } = makeResolver({});
    await resolver.setRef(BOT_EGRESS_TOKEN_SETTING, SECRET_OK);
    secrets.get(SECRET_OK)!.status = "disabled";
    await request(egressApp(resolver)).get(policyUrl).set("Authorization", `Bearer ${REF_TOKEN}`).expect(503);
  });

  it("is not published when the consumer is not allowed for the setting", async () => {
    const { resolver } = makeResolver({}, ["some-other-consumer"]);
    await resolver.setRef(BOT_EGRESS_TOKEN_SETTING, SECRET_OK);
    await request(egressApp(resolver)).get(policyUrl).set("Authorization", `Bearer ${REF_TOKEN}`).expect(503);
  });

  it("registers the value for log masking and keeps it out of status and plan", async () => {
    const { resolver, redacted } = makeResolver({});
    await resolver.setRef(BOT_EGRESS_TOKEN_SETTING, SECRET_OK);
    await resolver.resolve(BOT_EGRESS_TOKEN_SETTING, { consumerId: BOT_EGRESS_POLICY_CONSUMER });
    expect(redacted).toContain(REF_TOKEN);
    expect(JSON.stringify([await resolver.list(), await resolver.migrationPlan()])).not.toContain(REF_TOKEN);
  });
});

describe("egress refusal feed token", () => {
  let server: http.Server | null = null;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  it("presents the reference token to the proxy", async () => {
    let seen: string | undefined;
    server = http.createServer((req, res) => {
      seen = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ refusals: [{ host: "example.test" }] }));
    });
    await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
    const port = (server.address() as AddressInfo).port;
    const { resolver } = makeResolver({});
    await resolver.setRef(BOT_EGRESS_TOKEN_SETTING, SECRET_OK);
    const feed = egressRefusalFeed(
      { MYRMIDON_BOT_EGRESS_REFUSALS_URL: `http://127.0.0.1:${port}` },
      createTokenReaderFromResolver(() => resolver, BOT_EGRESS_TOKEN_SETTING, BOT_EGRESS_REFUSALS_CONSUMER),
    );
    expect(await feed()).toHaveLength(1);
    expect(seen).toBe(`Bearer ${REF_TOKEN}`);
  });
});

describe("dockergate token", () => {
  let gate: http.Server | null = null;
  afterEach(() => new Promise<void>((done) => (gate ? gate.close(() => done()) : done())));

  const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY] };

  async function startGate(): Promise<{ url: string; seen: () => string | undefined }> {
    let seen: string | undefined;
    gate = http.createServer((req, res) => {
      seen = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ projects: [], quotaEnabled: false }));
    });
    await new Promise<void>((ok) => gate!.listen(0, "127.0.0.1", ok));
    return { url: `http://127.0.0.1:${(gate.address() as AddressInfo).port}`, seen: () => seen };
  }

  function diskApp(url: string, resolver: ReturnType<typeof makeResolver>["resolver"]) {
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = member;
      next();
    });
    app.use(
      "/api",
      botDiskPhysicalRoutes({} as Db, {
        env: { MYRMIDON_DOCKERGATE_BASE_URL: url },
        readToken: createTokenReaderFromResolver(() => resolver, DOCKERGATE_TOKEN_SETTING, BOT_DISK_DOCKERGATE_CONSUMER),
      }),
    );
    app.use(errorHandler);
    return app;
  }

  it("calls the gate with the reference token", async () => {
    const { url, seen } = await startGate();
    const { resolver } = makeResolver({});
    await resolver.setRef(DOCKERGATE_TOKEN_SETTING, SECRET_OK);
    const res = await request(diskApp(url, resolver)).get("/api/myrmidon/bot-disk/physical").expect(200);
    expect(res.body.gateReached).toBe(true);
    expect(seen()).toBe(`Bearer ${REF_TOKEN}`);
  });

  it("calls the gate with the emergency env token when both are set", async () => {
    const { url, seen } = await startGate();
    const { resolver } = makeResolver({ MYRMIDON_DOCKERGATE_TOKEN: ENV_TOKEN });
    await resolver.setRef(DOCKERGATE_TOKEN_SETTING, SECRET_OK);
    await request(diskApp(url, resolver)).get("/api/myrmidon/bot-disk/physical").expect(200);
    expect(seen()).toBe(`Bearer ${ENV_TOKEN}`);
  });

  it("answers 'gate not configured' with no call when no reference is bound", async () => {
    const { url, seen } = await startGate();
    const { resolver } = makeResolver({});
    const res = await request(diskApp(url, resolver)).get("/api/myrmidon/bot-disk/physical").expect(200);
    expect(res.body.gateReached).toBe(false);
    expect(res.body.note).toBe("gate not configured");
    expect(seen()).toBeUndefined();
  });
});
