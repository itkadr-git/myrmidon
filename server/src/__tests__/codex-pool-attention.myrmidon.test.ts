// server/src/__tests__/codex-pool-attention.myrmidon.test.ts
//
// myrmidon(1.6.6 OPE-7198): the attention feed integration for Codex / ChatGPT
// subscription pool accounts.
//
// Asserts the complete production calling path:
// 1. Account state in the pool daemon (banned / 100% quota window exhaustion)
// 2. Server-side update (sweeper tick / syncPoolSignals / attention refresh hook)
// 3. Operator card appears in attention feed with correct severity, whyNow and links
// 4. Recovery in pool daemon -> server-side update -> card automatically clears from feed
// 5. Multi-provider isolation: Provider A's signals are not wiped by Provider B, and
//    removing Provider A only clears Provider A's cards.
//
// Live embedded postgres (matching tracing-attention.myrmidon.test.ts pattern).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  modelProviders,
} from "@myrmidonai/db";
import {
  clearModelProviderConnectors,
  DEFAULT_CHATGPT_POOL_MODELS,
  modelProviderSecretName,
  registerModelProviderConnector,
  type PoolAccountChannelView,
} from "@myrmidonai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { attentionService } from "../services/attention.js";
import { secretService } from "../services/secrets.js";
import {
  createModelProviderService,
  type ModelProviderCatalogPort,
} from "../myrmidon/model-providers/service.js";
import {
  clearPoolAccountSignals,
  reportPoolAccountStatus,
} from "../myrmidon/model-providers/signals.js";
import { createModelProviderPoolSweeper } from "../myrmidon/model-providers/sweep.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function channel(overrides: Partial<PoolAccountChannelView> = {}): PoolAccountChannelView {
  return {
    n: 1,
    label: "Account #1",
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
    ...overrides,
  };
}

describeEmbeddedPostgres("codex pool attention feed cards (OPE-7198)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-codex-attention-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    clearPoolAccountSignals();
    clearModelProviderConnectors();
    await db.delete(modelProviders);
    await db.delete(activityLog);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-codex-test",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  function setupService(catalog: ModelProviderCatalogPort) {
    const secrets = secretService(db);
    return createModelProviderService({
      db,
      secrets: {
        readSecretValue: (cid, name) =>
          secrets.getByName(cid, name).then((row) => (row ? secrets.resolveSecretValue(cid, row.id, "latest") : null)),
        findSecretId: (cid, name) => secrets.getByName(cid, name).then((row) => row?.id ?? null),
        createSecret: async (input) => {
          const created = (await secrets.create(
            input.companyId,
            {
              name: input.name,
              key: input.name,
              value: input.value,
              description: input.description,
              provider: "local_encrypted",
            } as never,
            { userId: null, agentId: null },
          )) as { id: string };
          return { id: created.id };
        },
        rotateSecret: async (id, value) => {
          await secrets.rotate(id, { value }, { userId: null, agentId: null });
        },
        deleteSecret: async (id) => {
          await secrets.remove(id);
        },
      },
      catalog,
    });
  }

  async function seedPoolProvider(provId: string, name = "Codex Pool") {
    const secretName = modelProviderSecretName(provId);
    const secrets = secretService(db);
    await secrets.create(
      companyId,
      {
        name: secretName,
        key: secretName,
        value: "test-pool-key",
        provider: "local_encrypted",
      } as never,
      { userId: null, agentId: null },
    );
    await db.insert(modelProviders).values({
      id: provId,
      companyId,
      type: "chatgpt-pool",
      name,
      baseUrl: "http://localhost:8895",
      credentialSecretName: secretName,
      free: false,
    });
  }

  it("server update path: pool ban -> sweeper/sync -> attention card -> recovery in pool -> card clears", async () => {
    await seedCompany();
    registerModelProviderConnector({
      type: "chatgpt-pool",
      defaultBaseUrl: "http://localhost:8895",
      defaultModels: DEFAULT_CHATGPT_POOL_MODELS,
      supportsChannels: true,
    });

    const providerId = randomUUID();
    await seedPoolProvider(providerId);

    // Mock pool accounts in external daemon
    let poolAccounts: PoolAccountChannelView[] = [
      channel({ n: 1, label: "Account #1", state: "active" }),
      channel({
        n: 2,
        label: "Account #2",
        state: "banned",
        isBanned: true,
      }),
      channel({
        n: 3,
        label: "Account #3",
        state: "rate_limited",
        isExhausted: true,
        windows: {
          primary: { usedPct: 30, windowMin: 300, resetsAt: 1700018000 },
          secondary: { usedPct: 100, windowMin: 10080, resetsAt: 1700600000 },
        },
      }),
    ];

    const catalog: ModelProviderCatalogPort = {
      listModels: async () => ({ models: ["gpt-6.1-sol"] }),
      listAccounts: async () => ({ accounts: poolAccounts }),
    };

    const service = setupService(catalog);

    // 1. Trigger the server sync via sweeper (or service.syncPoolSignals) — without viewing UI channels
    const sweeper = createModelProviderPoolSweeper(
      {
        listCompaniesWithPools: async () => [companyId],
        syncPoolSignals: (cid) => service.syncPoolSignals(cid),
      },
      60_000,
    );
    await sweeper.sweep();

    // 2. Query the attention feed
    const feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
    const cards = feed.items.filter((item) => item.sourceKind === "codex_pool_alert");
    expect(cards).toHaveLength(2);

    const bannedCard = cards.find((c) => c.subject.metadata?.kind === "banned");
    expect(bannedCard).toBeDefined();
    expect(bannedCard!.severity).toBe("high");
    expect(bannedCard!.subject.title).toContain("Account #2");
    expect(bannedCard!.subject.href).toContain("/company/settings/models");
    expect(bannedCard!.whyNow).toContain("Relogin or replace");

    const exhaustedCard = cards.find((c) => c.subject.metadata?.kind === "exhausted");
    expect(exhaustedCard).toBeDefined();
    expect(exhaustedCard!.severity).toBe("medium");
    expect(exhaustedCard!.subject.title).toContain("Account #3");
    expect(exhaustedCard!.whyNow).toContain("weekly window");
    expect(exhaustedCard!.subject.metadata?.resetsAt).toBe(1700600000);

    // 3. Accounts recover in the pool daemon
    poolAccounts = [
      channel({ n: 1, label: "Account #1", state: "active" }),
      channel({ n: 2, label: "Account #2", state: "active", isBanned: false }),
      channel({
        n: 3,
        label: "Account #3",
        state: "active",
        isExhausted: false,
        windows: {
          primary: { usedPct: 30, windowMin: 300, resetsAt: 1700018000 },
          secondary: { usedPct: 50, windowMin: 10080, resetsAt: 1700600000 },
        },
      }),
    ];

    // 4. Sweeper runs next tick
    await sweeper.sweep();
    sweeper.stop();

    // 5. Feed shows all cards cleared
    const feedAfterRecovery = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
    const remainingCards = feedAfterRecovery.items.filter((item) => item.sourceKind === "codex_pool_alert");
    expect(remainingCards).toHaveLength(0);
  });

  it("attention refresh hook: feed snapshot building automatically triggers pool sync without manual sweeper", async () => {
    await seedCompany();
    registerModelProviderConnector({
      type: "chatgpt-pool",
      defaultBaseUrl: "http://localhost:8895",
      defaultModels: DEFAULT_CHATGPT_POOL_MODELS,
      supportsChannels: true,
    });

    const providerId = randomUUID();
    await seedPoolProvider(providerId);

    const poolAccounts = [
      channel({ n: 10, label: "Account #10", state: "banned", isBanned: true }),
    ];

    const catalog: ModelProviderCatalogPort = {
      listModels: async () => ({ models: ["gpt-6.1-sol"] }),
      listAccounts: async () => ({ accounts: poolAccounts }),
    };

    const service = setupService(catalog);

    // Create attention service with poolSignalsSync hook
    const attention = attentionService(db, {
      feedCacheTtlMs: 0,
      poolSignalsSync: (cid) => service.syncPoolSignals(cid),
    });

    // Directly read attention without running any sweep command first:
    // the feed build itself invokes poolSignalsSync and surfaces the card!
    const feed = await attention.list(companyId);
    const cards = feed.items.filter((item) => item.sourceKind === "codex_pool_alert");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.subject.title).toContain("Account #10");
  });

  it("multi-provider isolation: Provider A removal does not clear Provider B cards", async () => {
    await seedCompany();
    registerModelProviderConnector({
      type: "chatgpt-pool",
      defaultBaseUrl: "http://localhost:8895",
      defaultModels: DEFAULT_CHATGPT_POOL_MODELS,
      supportsChannels: true,
    });

    const provA = randomUUID();
    const provB = randomUUID();
    await seedPoolProvider(provA, "Pool A");
    await seedPoolProvider(provB, "Pool B");

    const catalog: ModelProviderCatalogPort = {
      listModels: async () => ({ models: ["gpt-6.1-sol"] }),
      listAccounts: async ({ apiKey }) => {
        // apiKey is test-pool-key for both, return distinct accounts
        return {
          accounts: [
            channel({ n: 1, label: "Account A-1", state: "banned", isBanned: true }),
          ],
        };
      },
    };

    const service = setupService(catalog);

    // Sync provider A and report an event for provider B
    await service.syncPoolSignals(companyId, provA);
    reportPoolAccountStatus({
      companyId,
      providerId: provB,
      account: channel({
        n: 2,
        label: "Account B-2",
        state: "rate_limited",
        isExhausted: true,
        windows: {
          primary: { usedPct: 100, windowMin: 300, resetsAt: 1700020000 },
          secondary: null,
        },
      }),
    });

    let feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
    let cards = feed.items.filter((item) => item.sourceKind === "codex_pool_alert");
    expect(cards).toHaveLength(2);

    // Remove provider A via service: must clear Provider A's signals, leaving Provider B intact
    await service.removeProvider({ companyId, providerId: provA });

    feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
    cards = feed.items.filter((item) => item.sourceKind === "codex_pool_alert");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.subject.metadata?.providerId).toBe(provB);
  });
});
