// server/src/__tests__/codex-pool-attention.myrmidon.test.ts
//
// myrmidon(1.6.6 OPE-7198): the attention feed integration for Codex / ChatGPT
// subscription pool accounts.
//
// When an account is banned or token-expired, or when its quota window (5h or weekly)
// is exhausted, it surfaces as an operator attention card on the desk. When the account
// recovers or limit resets, the card clears on the next feed read.
//
// Live embedded postgres (matching tracing-attention.myrmidon.test.ts pattern).

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import type { PoolAccountChannelView } from "@paperclipai/shared";
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
import {
  clearPoolAccountSignals,
  CODEX_POOL_ALERT_DEDUP_PREFIX,
  evaluateAccountSignals,
  recordPoolAccountSignals,
  reportPoolAccountStatus,
} from "../myrmidon/model-providers/signals.js";

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
    await db.delete(activityLog);
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

  it("raises no card when all pool accounts are active and healthy", async () => {
    await seedCompany();
    const providerId = "prov-pool-1";

    const healthyAccounts = [
      channel({ n: 1, label: "Account #1" }),
      channel({ n: 2, label: "Account #2" }),
    ];
    const signals = evaluateAccountSignals(companyId, providerId, healthyAccounts);
    recordPoolAccountSignals(companyId, providerId, signals);

    const feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
    const cards = feed.items.filter((item) => item.sourceKind === "codex_pool_alert");
    expect(cards).toHaveLength(0);
  });

  it("banned and weekly-exhausted accounts raise cards with correct severity, whyNow and href", async () => {
    await seedCompany();
    const providerId = "prov-pool-1";

    const accounts = [
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
          primary: { usedPct: 40, windowMin: 300, resetsAt: 1700018000 },
          secondary: { usedPct: 100, windowMin: 10080, resetsAt: 1700600000 },
        },
      }),
    ];

    const signals = evaluateAccountSignals(companyId, providerId, accounts);
    recordPoolAccountSignals(companyId, providerId, signals);

    const feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
    const cards = feed.items.filter((item) => item.sourceKind === "codex_pool_alert");
    expect(cards).toHaveLength(2);

    const bannedCard = cards.find((c) => c.subject.metadata?.kind === "banned");
    expect(bannedCard).toBeDefined();
    expect(bannedCard!.severity).toBe("high");
    expect(bannedCard!.subject.title).toContain("Account #2");
    expect(bannedCard!.subject.href).toContain("/company/settings/models");
    expect(bannedCard!.whyNow).toContain("relogin or replace");
    expect(bannedCard!.relatedIssue).toBeNull();

    const exhaustedCard = cards.find((c) => c.subject.metadata?.kind === "exhausted");
    expect(exhaustedCard).toBeDefined();
    expect(exhaustedCard!.severity).toBe("medium");
    expect(exhaustedCard!.subject.title).toContain("Account #3");
    expect(exhaustedCard!.whyNow).toContain("weekly window");
    expect(exhaustedCard!.subject.metadata?.resetsAt).toBe(1700600000);
  });

  it("multi-provider isolation: signals for provider A are preserved when provider B updates", async () => {
    await seedCompany();
    const provA = "prov-pool-a";
    const provB = "prov-pool-b";

    // Provider A has banned account #1
    reportPoolAccountStatus({
      companyId,
      providerId: provA,
      account: channel({ n: 1, label: "A-1", state: "banned", isBanned: true }),
    });

    // Provider B has exhausted account #2
    reportPoolAccountStatus({
      companyId,
      providerId: provB,
      account: channel({
        n: 2,
        label: "B-2",
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
    expect(cards.some((c) => c.subject.metadata?.providerId === provA)).toBe(true);
    expect(cards.some((c) => c.subject.metadata?.providerId === provB)).toBe(true);

    // Clear provider A: provider B cards must remain intact
    clearPoolAccountSignals(companyId, provA);

    feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
    cards = feed.items.filter((item) => item.sourceKind === "codex_pool_alert");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.subject.metadata?.providerId === provB).toBe(true);
  });

  it("recovery clears the attention card on next feed read", async () => {
    await seedCompany();
    const providerId = "prov-pool-1";

    // Account #5 is banned
    reportPoolAccountStatus({
      companyId,
      providerId,
      account: channel({ n: 5, label: "Account #5", state: "banned", isBanned: true }),
    });

    let feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
    expect(feed.items.filter((item) => item.sourceKind === "codex_pool_alert")).toHaveLength(1);

    // Account #5 recovers
    reportPoolAccountStatus({
      companyId,
      providerId,
      account: channel({ n: 5, label: "Account #5", state: "active", isBanned: false, isExhausted: false }),
    });

    feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
    expect(feed.items.filter((item) => item.sourceKind === "codex_pool_alert")).toHaveLength(0);
  });
});
