// server/src/myrmidon/model-providers/model-providers-pools.myrmidon.test.ts
//
// myrmidon(1.6.7 OPE-12345): adding a pool provider through the real service.
//
//  - a registered antigravity-pool connector yields exactly the four gateway
//    group names as the provider's models (no `<type>/` prefix);
//  - the ChatGPT pool keeps its `chatgpt-pool/<model>` group names;
//  - a connector that declares no models never inherits the ChatGPT models.
//
// The service takes a plain fake of the database and the catalog; nothing in
// it can reach a gateway, which is the point of a pool provider.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearModelProviderConnectors,
  DEFAULT_ANTIGRAVITY_POOL_MODELS,
  DEFAULT_CHATGPT_POOL_MODELS,
  registerModelProviderConnector,
} from "@myrmidon/shared";
import { modelProviderModels, modelProviders } from "@myrmidon/db";
import { createModelProviderService, type ModelProviderCatalogPort } from "./service.js";
import { registerConnectorsForPlugin } from "./plugin-lifecycle.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BASE_URL = "http://pool.test:9000";

interface InsertedModel {
  providerId: string;
  modelName: string;
  litellmModelName: string;
  enabled: boolean;
  free: boolean;
}

/** An in-memory stand-in for the three statements createProvider issues. */
function fakeDb(type: string, name: string) {
  const insertedModels: InsertedModel[] = [];
  const providerRow = {
    id: "prov-new",
    companyId: COMPANY_ID,
    type,
    name,
    baseUrl: BASE_URL,
    free: false,
    expiresAt: null,
    packageName: null,
    rpmLimit: null,
    toolCallCompatible: null,
    toolCallCheckedAt: null,
    toolCallCheckError: null,
    keyValidatedAt: new Date("2026-11-08T00:00:00.000Z"),
    credentialSecretName: null,
    createdAt: new Date("2026-11-08T00:00:00.000Z"),
    updatedAt: new Date("2026-11-08T00:00:00.000Z"),
  };
  const emptyRows = () => {
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "where", "limit", "innerJoin"]) chain[step] = () => chain;
    chain.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
    return chain;
  };
  const db = {
    select: () => emptyRows(),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (table === modelProviderModels) {
          insertedModels.push(...(values as InsertedModel[]));
          return Promise.resolve();
        }
        expect(table).toBe(modelProviders);
        return { returning: async () => [providerRow] };
      },
    }),
    delete: () => ({ where: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  return { db, insertedModels };
}

function service(type: string, name: string) {
  const { db, insertedModels } = fakeDb(type, name);
  const catalog: ModelProviderCatalogPort = {
    listModels: vi.fn(async () => ({ models: ["must-not-be-used"] })),
    listAccounts: vi.fn(async () => ({ accounts: [] })),
  };
  const secrets = {
    readSecretValue: vi.fn(async () => "key"),
    findSecretId: vi.fn(async () => "sec-1"),
    createSecret: vi.fn(async () => ({ id: "sec-new" })),
    rotateSecret: vi.fn(async () => undefined),
    restoreSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
  };
  return {
    insertedModels,
    catalog,
    secrets,
    svc: createModelProviderService({ db: db as never, secrets, catalog }),
  };
}

describe("myrmidon(1.6.7 OPE-12345) adding a pool provider", () => {
  beforeEach(() => clearModelProviderConnectors());
  afterEach(() => clearModelProviderConnectors());

  it("antigravity-pool: the four gateway groups, named without a type prefix", async () => {
    registerConnectorsForPlugin({ pluginKey: "myrmidon.antigravity" });
    const { svc, insertedModels, catalog } = service("antigravity-pool", "Antigravity");

    const created = await svc.createProvider({
      companyId: COMPANY_ID,
      body: { type: "antigravity-pool", name: "Antigravity", key: "pool-token", baseUrl: BASE_URL } as never,
    });

    expect(created.type).toBe("antigravity-pool");
    expect(catalog.listAccounts).toHaveBeenCalledWith({ baseUrl: BASE_URL, apiKey: "pool-token" });
    expect(catalog.listModels).not.toHaveBeenCalled();
    expect(insertedModels.map((m) => m.modelName)).toEqual([
      "antigravity/gemini-3.8-flash-high",
      "antigravity/gemini-3.8-flash-medium",
      "antigravity/gemini-3.8-flash-low",
      "antigravity/gemini-3.5-flash-lite",
    ]);
    // The gateway group of a pool model is the model id itself.
    expect(insertedModels.map((m) => m.litellmModelName)).toEqual(insertedModels.map((m) => m.modelName));
    expect(insertedModels.every((m) => m.enabled && m.providerId === "prov-new")).toBe(true);
    expect(insertedModels.map((m) => m.modelName)).toEqual([...DEFAULT_ANTIGRAVITY_POOL_MODELS]);
    // None of the ChatGPT models leaked into the antigravity provider.
    expect(insertedModels.some((m) => (DEFAULT_CHATGPT_POOL_MODELS as readonly string[]).includes(m.modelName))).toBe(
      false,
    );
  });

  it("chatgpt-pool: models keep the chatgpt-pool/<model> group names", async () => {
    registerConnectorsForPlugin({ pluginKey: "myrmidon.chatgpt-pool" });
    const { svc, insertedModels } = service("chatgpt-pool", "Codex Pool");

    await svc.createProvider({
      companyId: COMPANY_ID,
      body: { type: "chatgpt-pool", name: "Codex Pool", key: "pool-token", baseUrl: BASE_URL } as never,
    });

    expect(insertedModels.map((m) => m.modelName)).toEqual([...DEFAULT_CHATGPT_POOL_MODELS]);
    expect(insertedModels.map((m) => m.litellmModelName)).toEqual(
      DEFAULT_CHATGPT_POOL_MODELS.map((model) => `chatgpt-pool/${model}`),
    );
  });

  it("google-ai-pool: registers with no models until the connector declares some", async () => {
    registerConnectorsForPlugin({ pluginKey: "myrmidon.google-ai" });
    const { svc, insertedModels } = service("google-ai-pool", "Google AI");

    const created = await svc.createProvider({
      companyId: COMPANY_ID,
      body: { type: "google-ai-pool", name: "Google AI", key: "pool-token", baseUrl: BASE_URL } as never,
    });

    expect(created.type).toBe("google-ai-pool");
    expect(insertedModels).toEqual([]);
  });

  it("a connector without defaultModels does not get the ChatGPT models", async () => {
    registerModelProviderConnector({ type: "custom-pool", pluginKey: "custom.plugin", supportsChannels: true });
    const { svc, insertedModels } = service("custom-pool", "Custom");

    await svc.createProvider({
      companyId: COMPANY_ID,
      body: { type: "custom-pool", name: "Custom", key: "pool-token", baseUrl: BASE_URL } as never,
    });

    expect(insertedModels).toEqual([]);
  });

  it("antigravity-pool without a base URL is refused with the field named, not guessed", async () => {
    registerConnectorsForPlugin({ pluginKey: "myrmidon.antigravity" });
    const { svc, catalog } = service("antigravity-pool", "Antigravity");

    await expect(
      svc.createProvider({
        companyId: COMPANY_ID,
        body: { type: "antigravity-pool", name: "Antigravity", key: "pool-token" } as never,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(catalog.listAccounts).not.toHaveBeenCalled();
  });
});
