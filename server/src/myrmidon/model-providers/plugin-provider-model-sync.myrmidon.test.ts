// server/src/myrmidon/model-providers/plugin-provider-model-sync.myrmidon.test.ts
//
// myrmidon(1.6.6 OPE-7251 CHANGES-2): regression test for the multi-plugin and
// cross-company semantics of createPluginProviderModelSync.
//
// The owner's CHANGES pin three contracts:
//  1. /key/update replaces its model list, so enabling a second provider
//     plugin (Gemini after the ChatGPT pool) must not drop the first plugin's
//     models from the company's allowlist update — the union of ALL ready
//     plugin declarations of that company is sent.
//  2. The union is company-scoped: company A's plugins never put model names
//     into company B's allowlist update.
//  3. Removing (disabling) one plugin keeps the models of the other ready
//     plugin in the allowlist and only unregisters the removed plugin's own
//     models from the gateway.
//
// Runs against a real embedded-postgres database (real WHERE clauses — that is
// what makes the company isolation test meaningful), with the secret store,
// the LiteLLM HTTP client and the per-agent allowlist pass mocked so the suite
// observes exactly what would be sent to the gateway and the agent keys.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDb, companies, pluginConfig, plugins, type Db } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

// --- mocks: what leaves the process ------------------------------------

const secretGetByName = vi.fn();
const secretResolve = vi.fn();
vi.mock("../../services/index.js", () => ({
  secretService: () => ({
    getByName: secretGetByName,
    resolveSecretValue: secretResolve,
  }),
  logActivity: vi.fn(),
}));

const registeredModels: Array<{ litellmModelName: string; providerType: string; credentialSecretName: string }> = [];
const unregisteredModels: string[] = [];
vi.mock("../litellm-sync/client.js", () => ({
  createLitellmSyncClient: () => ({
    registerModel: async (input: { litellmModelName: string; providerType: string; credentialSecretName: string }) => {
      registeredModels.push({
        litellmModelName: input.litellmModelName,
        providerType: input.providerType,
        credentialSecretName: input.credentialSecretName,
      });
    },
    unregisterModel: async (name: string) => {
      unregisteredModels.push(name);
    },
  }),
}));

const allowlistUpdates: Array<{ companyId: string; models: string[]; allowEmpty?: boolean }> = [];
vi.mock("../litellm-sync/agent-allowlist-handler.js", () => ({
  updateAgentAllowlistsForCompany: vi.fn(
    async (
      _db: Db,
      _deps: unknown,
      companyId: string,
      additional?: readonly string[],
      removed?: readonly string[],
      allowEmpty?: boolean,
    ) => {
      allowlistUpdates.push({ companyId, models: [...(additional ?? [])], allowEmpty });
      void removed;
    },
  ),
}));

import { createPluginProviderModelSync } from "./wiring.js";
import type { PluginRecord } from "@myrmidon/shared";

// --- fixtures -------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

const ENV = {
  MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
  MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin",
} as NodeJS.ProcessEnv;

/** A ready provider-plugin row manifest as the registry stores it. */
const chatgptPoolManifest = {
  providerModels: {
    provider: "chatgpt-pool",
    baseUrl: "https://chatgpt-pool.internal/v1",
    credentialSecretName: "chatgpt-pool-credential",
    models: [
      { id: "gpt-5.2", name: "GPT-5.2" },
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    ],
  },
};

const geminiManifest = {
  providerModels: {
    provider: "google-ai-gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    credentialSecretName: "google-ai-gemini-credential",
    models: [{ id: "gemini-3-pro", name: "Gemini 3 Pro" }],
  },
};

async function seedPlugin(db: Db, pluginKey: string, manifest: unknown, companyIds: string[]) {
  const [row] = await db
    .insert(plugins)
    .values({
      pluginKey,
      packageName: `@myrmidon/${pluginKey}`,
      version: "1.0.0",
      manifestJson: manifest as PluginRecord["manifestJson"],
      status: "ready",
    })
    .returning({ id: plugins.id });
  for (const companyId of companyIds) {
    await db.insert(pluginConfig).values({ pluginId: row.id, companyId });
  }
  return row.id;
}

let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
let db: Db | null = null;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-plugin-provider-sync-");
  db = createDb(tempDb.connectionString);
  // The embedded Postgres first boot (initdb) can exceed the shard's 30s
  // hookTimeout on a loaded build VPS; 180s is still bounded and far below the
  // CI job limit. The teardown stays on the default budget.
}, 180_000);

afterAll(async () => {
  if (tempDb) await tempDb.cleanup();
});

beforeEach(async () => {
  if (!db) return;
  await db.delete(pluginConfig);
  await db.delete(plugins);
  // only the two fixture companies; the template company row must survive
  await db.delete(companies).where(inArray(companies.id, [COMPANY_A, COMPANY_B]));
  secretGetByName.mockReset();
  secretResolve.mockReset();
  registeredModels.length = 0;
  unregisteredModels.length = 0;
  allowlistUpdates.length = 0;
  // The admin key and every plugin credential resolve; per-company scoping of
  // secrets is wiring's own concern, covered by the credential-owner test.
  secretResolve.mockImplementation(async () => "sk-admin-resolved");
  secretGetByName.mockImplementation(async (_companyId: string, name: string) => ({ id: `secret-${name}` }));
  await db.insert(companies).values([
    { id: COMPANY_A, name: "Company A", issuePrefix: "7A1" },
    { id: COMPANY_B, name: "Company B", issuePrefix: "7B2" },
  ]);
});

describeEmbeddedPostgres("createPluginProviderModelSync multi-plugin / multi-company semantics", () => {
  it("keeps the first plugin's models when a second provider plugin is enabled (union, /key/update replace-safe)", async () => {
    if (!db) throw new Error("db not ready");
    const poolId = await seedPlugin(db, "myrmidon.chatgpt-pool", chatgptPoolManifest, [COMPANY_A]);
    await seedPlugin(db, "myrmidon.google-ai-gemini", geminiManifest, [COMPANY_A]);

    const { sync } = createPluginProviderModelSync(db, ENV);
    // Enable ChatGPT pool first.
    const poolRow = (await db.select().from(plugins).where(eq(plugins.id, poolId)))[0] as unknown as PluginRecord;
    await sync(COMPANY_A, poolRow);
    expect(allowlistUpdates).toHaveLength(1);
    expect(allowlistUpdates[0].companyId).toBe(COMPANY_A);
    expect(allowlistUpdates[0].models.sort()).toEqual(["chatgpt-pool/gpt-5.2", "chatgpt-pool/gpt-5.2-codex", "google-ai-gemini/gemini-3-pro"]);

    // Re-sync (idempotent enable) must not drop anything either.
    await sync(COMPANY_A, poolRow);
    expect(allowlistUpdates[1].models.sort()).toEqual(allowlistUpdates[0].models.sort());
  });

  it("scopes the allowlist union to the company (no cross-company model leak)", async () => {
    if (!db) throw new Error("db not ready");
    await seedPlugin(db, "myrmidon.chatgpt-pool", chatgptPoolManifest, [COMPANY_A]);
    await seedPlugin(db, "myrmidon.google-ai-gemini", geminiManifest, [COMPANY_B]);

    const { sync } = createPluginProviderModelSync(db, ENV);
    const [poolRow] = await db.select().from(plugins);
    const [geminiRow] = await db.select().from(plugins).where(eq(plugins.pluginKey, "myrmidon.google-ai-gemini"));
    await sync(COMPANY_A, poolRow as unknown as PluginRecord);
    await sync(COMPANY_B, geminiRow as unknown as PluginRecord);

    const updateA = allowlistUpdates.find((u) => u.companyId === COMPANY_A);
    const updateB = allowlistUpdates.find((u) => u.companyId === COMPANY_B);
    expect(updateA?.models).toEqual(["chatgpt-pool/gpt-5.2", "chatgpt-pool/gpt-5.2-codex"]);
    expect(updateB?.models).toEqual(["google-ai-gemini/gemini-3-pro"]);
  });

  it("disable removes only that plugin's models and keeps the sibling plugin's models allowed", async () => {
    if (!db) throw new Error("db not ready");
    const poolId = await seedPlugin(db, "myrmidon.chatgpt-pool", chatgptPoolManifest, [COMPANY_A]);
    await seedPlugin(db, "myrmidon.google-ai-gemini", geminiManifest, [COMPANY_A]);

    const { sync, remove } = createPluginProviderModelSync(db, ENV);
    const poolRow = (await db.select().from(plugins).where(eq(plugins.id, poolId)))[0] as unknown as PluginRecord;
    await sync(COMPANY_A, poolRow);

    // Disable the ChatGPT pool plugin: only its two models are unregistered.
    await remove(COMPANY_A, poolRow);
    expect(unregisteredModels.sort()).toEqual(["chatgpt-pool/gpt-5.2", "chatgpt-pool/gpt-5.2-codex"]);
    const last = allowlistUpdates[allowlistUpdates.length - 1];
    expect(last.companyId).toBe(COMPANY_A);
    expect(last.models).toEqual(["google-ai-gemini/gemini-3-pro"]);
  });
});
