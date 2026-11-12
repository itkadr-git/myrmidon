// server/src/myrmidon/model-providers/model-providers-litellm-names.myrmidon.test.ts
//
// myrmidon(1.6.7 LITELLM-BOARD-SYNC): the registry's LiteLLM model name is
// settable. It used to be derived once as `<type>/<model name>`, so a registry
// could never match a gateway group that already exists under another name
// (`kimi/kimi-for-coding`).
//
// - at creation: `litellmModelNames` maps the provider's model name to the
//   gateway name; a model without an entry keeps the default; a name for a
//   model the provider does not list is refused before anything is written;
// - with `setModels`: a model's `litellmModelName` can be changed, but only
//   while the model is disabled (the gateway registration is keyed by the name,
//   and the enable/disable sync acts on the name the row holds AFTER the write);
// - a key rotation re-reads the provider's model list and must not reset the
//   names the operator chose.
//
// Plain fakes: a scripted db (each select takes the next prepared rows) and an
// in-memory secret store. The service's own suite against a real database is
// model-providers.db.myrmidon.test.ts.

import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { createModelProviderSchema, setModelProviderModelsSchema } from "@myrmidon/shared";
import {
  createModelProviderService,
  type ModelProviderCatalogPort,
  type ModelProviderSecretStoreDeps,
} from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-01-02T00:00:00Z");

const PROVIDER_ROW = {
  id: PROVIDER_ID,
  companyId: COMPANY_ID,
  type: "openai-compatible" as const,
  name: "Kimi",
  baseUrl: "https://kimi.invalid/coding/v1",
  credentialSecretName: `model-provider-key-${PROVIDER_ID}`,
  free: false,
  expiresAt: null,
  packageName: null,
  rpmLimit: null,
  keyValidatedAt: NOW,
  toolCallCompatible: null,
  toolCallCheckedAt: null,
  toolCallCheckError: null,
  createdAt: NOW,
  updatedAt: NOW,
};

interface Write {
  op: "insert" | "update" | "delete";
  values?: unknown;
  patch?: Record<string, unknown>;
}

/**
 * A scripted fake of the drizzle builder: each `select()` takes the next
 * prepared rows; inserts, updates and deletes are recorded in order.
 * `insertReturning` answers `insert(...).values(...).returning()`.
 */
function scriptedDb(selects: unknown[][], insertReturning: unknown[] = []) {
  const queue = [...selects];
  const writes: Write[] = [];
  const db = {
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
    insert: () => ({
      values: (values: unknown) => {
        writes.push({ op: "insert", values });
        return {
          returning: async () => insertReturning,
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve, reject),
        };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          writes.push({ op: "update", patch });
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        writes.push({ op: "delete" });
      },
    }),
  };
  return { db: db as unknown as Db, writes };
}

function fakeSecrets(): ModelProviderSecretStoreDeps {
  const store = new Map<string, string>();
  return {
    readSecretValue: async (_companyId, name) => store.get(name) ?? null,
    findSecretId: async (_companyId, name) => (store.has(name) ? `id-${name}` : null),
    createSecret: async ({ name, value }) => {
      store.set(name, value);
      return { id: `id-${name}` };
    },
    rotateSecret: async (secretId, value) => {
      store.set(secretId.replace(/^id-/, ""), value);
    },
    restoreSecret: async () => {},
    deleteSecret: async () => {},
  };
}

/** The provider lists the same three models for any key. */
const catalog: ModelProviderCatalogPort = {
  async listModels() {
    return { models: ["kimi-for-coding", "kimi-k2", "kimi-k2-turbo"] };
  },
};

const insertedModels = (writes: Write[]) =>
  writes.filter((w) => w.op === "insert" && Array.isArray(w.values)).flatMap((w) => w.values as Array<Record<string, unknown>>);

describe("litellmModelName at creation", () => {
  const providerRow = { ...PROVIDER_ROW, credentialSecretName: null };

  it("keeps the default <type>/<model> and applies the names the operator gave", async () => {
    const { db, writes } = scriptedDb([[]], [providerRow]);
    const service = createModelProviderService({ db, secrets: fakeSecrets(), catalog, now: () => NOW });

    await service.createProvider({
      companyId: COMPANY_ID,
      body: {
        type: "openai-compatible",
        name: "Kimi",
        baseUrl: "https://kimi.invalid/coding/v1",
        key: "provider-key-value",
        litellmModelNames: { "kimi-for-coding": "kimi/kimi-for-coding" },
      },
    });

    const models = insertedModels(writes);
    expect(models.map((m) => [m.modelName, m.litellmModelName])).toEqual([
      ["kimi-for-coding", "kimi/kimi-for-coding"],
      ["kimi-k2", "openai-compatible/kimi-k2"],
      ["kimi-k2-turbo", "openai-compatible/kimi-k2-turbo"],
    ]);
  });

  it("refuses a name for a model the provider does not list, before anything is written", async () => {
    const { db, writes } = scriptedDb([[]], [providerRow]);
    const secrets = fakeSecrets();
    const service = createModelProviderService({ db, secrets, catalog, now: () => NOW });

    await expect(
      service.createProvider({
        companyId: COMPANY_ID,
        body: {
          type: "openai-compatible",
          name: "Kimi",
          baseUrl: "https://kimi.invalid/coding/v1",
          key: "provider-key-value",
          litellmModelNames: { "kimi-for-codng": "kimi/kimi-for-coding" },
        },
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "model_provider_unknown_model" } });

    expect(writes).toEqual([]);
    expect(await secrets.findSecretId(COMPANY_ID, `model-provider-key-${PROVIDER_ID}`)).toBeNull();
  });
});

describe("litellmModelName with setModels", () => {
  const modelRow = (overrides: Record<string, unknown>) => ({
    id: "m-1",
    modelName: "kimi-for-coding",
    litellmModelName: "openai-compatible/kimi-for-coding",
    enabled: false,
    free: false,
    ...overrides,
  });

  /** setModels reads: the provider, then (listModels) the provider again and the rows; the same again after the writes. */
  function setModelsDb(before: Record<string, unknown>[], after: Record<string, unknown>[]) {
    return scriptedDb([[PROVIDER_ROW], [PROVIDER_ROW], before, [PROVIDER_ROW], after]);
  }

  it("renames a disabled model", async () => {
    const renamed = modelRow({ litellmModelName: "kimi/kimi-for-coding" });
    const { db, writes } = setModelsDb([modelRow({})], [renamed]);
    const service = createModelProviderService({ db, secrets: fakeSecrets(), catalog, now: () => NOW });

    const models = await service.setModels({
      companyId: COMPANY_ID,
      providerId: PROVIDER_ID,
      models: [{ modelName: "kimi-for-coding", litellmModelName: "kimi/kimi-for-coding" }],
    });

    expect(writes.filter((w) => w.op === "update").map((w) => w.patch)).toEqual([
      { updatedAt: NOW, litellmModelName: "kimi/kimi-for-coding" },
    ]);
    expect(models[0]).toMatchObject({ modelName: "kimi-for-coding", litellmModelName: "kimi/kimi-for-coding" });
  });

  it("renames and enables in one call (the sync then registers the new name)", async () => {
    const { db, writes } = setModelsDb([modelRow({})], [modelRow({ enabled: true, litellmModelName: "kimi/kimi-for-coding" })]);
    const service = createModelProviderService({ db, secrets: fakeSecrets(), catalog, now: () => NOW });

    await service.setModels({
      companyId: COMPANY_ID,
      providerId: PROVIDER_ID,
      models: [{ modelName: "kimi-for-coding", enabled: true, litellmModelName: "kimi/kimi-for-coding" }],
    });

    expect(writes.filter((w) => w.op === "update").map((w) => w.patch)).toEqual([
      { updatedAt: NOW, enabled: true, litellmModelName: "kimi/kimi-for-coding" },
    ]);
  });

  it("refuses to rename an enabled model, even in the call that disables it", async () => {
    const enabled = modelRow({ enabled: true });
    const { db, writes } = setModelsDb([enabled], [enabled]);
    const service = createModelProviderService({ db, secrets: fakeSecrets(), catalog, now: () => NOW });

    await expect(
      service.setModels({
        companyId: COMPANY_ID,
        providerId: PROVIDER_ID,
        models: [{ modelName: "kimi-for-coding", enabled: false, litellmModelName: "kimi/kimi-for-coding" }],
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "model_provider_model_enabled" } });
    expect(writes).toEqual([]);
  });

  it("accepts the unchanged name on an enabled model (a no-op, not a rename)", async () => {
    const enabled = modelRow({ enabled: true });
    const { db, writes } = setModelsDb([enabled], [enabled]);
    const service = createModelProviderService({ db, secrets: fakeSecrets(), catalog, now: () => NOW });

    await service.setModels({
      companyId: COMPANY_ID,
      providerId: PROVIDER_ID,
      models: [{ modelName: "kimi-for-coding", free: true, litellmModelName: "openai-compatible/kimi-for-coding" }],
    });

    expect(writes.filter((w) => w.op === "update")).toHaveLength(1);
  });
});

describe("litellmModelName survives a key rotation", () => {
  it("re-reads the provider's models but keeps the names the operator chose", async () => {
    const secrets = fakeSecrets();
    await secrets.createSecret({
      companyId: COMPANY_ID,
      name: PROVIDER_ROW.credentialSecretName,
      value: "old-key-value",
      description: "",
    });
    const { db, writes } = scriptedDb([
      [PROVIDER_ROW], // loadProvider
      [
        // the current snapshot: one custom name, one default
        { modelName: "kimi-for-coding", litellmModelName: "kimi/kimi-for-coding" },
        { modelName: "kimi-k2", litellmModelName: "openai-compatible/kimi-k2" },
      ],
    ]);
    const service = createModelProviderService({ db, secrets, catalog, now: () => NOW });

    await service.rotateProviderKey({ companyId: COMPANY_ID, providerId: PROVIDER_ID, key: "new-key-value" });

    expect(insertedModels(writes).map((m) => [m.modelName, m.litellmModelName])).toEqual([
      ["kimi-for-coding", "kimi/kimi-for-coding"],
      ["kimi-k2", "openai-compatible/kimi-k2"],
      ["kimi-k2-turbo", "openai-compatible/kimi-k2-turbo"],
    ]);
  });
});

describe("request schemas", () => {
  const create = { type: "openai-compatible", name: "Kimi", baseUrl: "https://kimi.invalid/v1", key: "provider-key-value" };

  it("createModelProviderSchema accepts a litellmModelNames map and trims its names", () => {
    const parsed = createModelProviderSchema.parse({
      ...create,
      litellmModelNames: { "kimi-for-coding": "  kimi/kimi-for-coding " },
    });
    expect(parsed.litellmModelNames).toEqual({ "kimi-for-coding": "kimi/kimi-for-coding" });
    expect(createModelProviderSchema.parse(create).litellmModelNames).toBeUndefined();
  });

  it("createModelProviderSchema refuses an empty gateway name", () => {
    expect(createModelProviderSchema.safeParse({ ...create, litellmModelNames: { "kimi-for-coding": "  " } }).success).toBe(false);
  });

  it("setModelProviderModelsSchema takes an optional litellmModelName per model and refuses an empty one", () => {
    expect(
      setModelProviderModelsSchema.parse({ models: [{ modelName: "kimi-for-coding", litellmModelName: "kimi/kimi-for-coding" }] })
        .models[0]!.litellmModelName,
    ).toBe("kimi/kimi-for-coding");
    expect(setModelProviderModelsSchema.parse({ models: [{ modelName: "kimi-for-coding", enabled: true }] }).models[0]!.litellmModelName).toBeUndefined();
    expect(setModelProviderModelsSchema.safeParse({ models: [{ modelName: "m", litellmModelName: "" }] }).success).toBe(false);
  });
});
