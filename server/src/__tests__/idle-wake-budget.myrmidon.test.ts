import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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

import {
  TEAM_LIVENESS_CARD_KEY,
  resolveTeamLivenessSettings,
  type ResolvedTeamLiveness,
} from "@paperclipai/shared";
import {
  createIdlePickupSweeper,
  createIdleWakeBudget,
  DEFAULT_IDLE_PICKUP_WAKE_BATCH,
  DEFAULT_IDLE_PICKUP_WAKE_BUDGET_PER_MIN,
  idlePickupForAgent,
  IDLE_PICKUP_ENABLED_ENV,
  IDLE_PICKUP_WAKE_BATCH_ENV,
  IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV,
  IDLE_PICKUP_WAKE_WINDOW_MS,
  MAX_IDLE_PICKUP_WAKE_BUDGET_PER_MIN,
  readIdleWakeBudgetSettings,
} from "../myrmidon/idle-pickup.ts";

// IDLE-WAKE-BUDGET: the company-wide ceiling of idle-pickup wakes (default five
// a minute), emitted in batches of one pass, plus the settings that move both
// numbers. The budget exists because every wake is a full LLM session: a board
// with twenty idle agents must not start twenty runs in one tick.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("wake budget settings readers", () => {
  it("defaults to five wakes a minute in batches of five", () => {
    expect(readIdleWakeBudgetSettings({})).toEqual({
      perMinute: DEFAULT_IDLE_PICKUP_WAKE_BUDGET_PER_MIN,
      batch: DEFAULT_IDLE_PICKUP_WAKE_BATCH,
    });
    expect(DEFAULT_IDLE_PICKUP_WAKE_BUDGET_PER_MIN).toBe(5);
  });

  it("falls back to the default on unreadable, zero, negative or fractional values", () => {
    for (const raw of ["", "  ", "abc", "0", "-3", "2.5", "5wakes"]) {
      expect(
        readIdleWakeBudgetSettings({ [IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV]: raw }).perMinute,
        `raw=${JSON.stringify(raw)}`,
      ).toBe(DEFAULT_IDLE_PICKUP_WAKE_BUDGET_PER_MIN);
      expect(
        readIdleWakeBudgetSettings({ [IDLE_PICKUP_WAKE_BATCH_ENV]: raw }).batch,
        `batch raw=${JSON.stringify(raw)}`,
      ).toBe(DEFAULT_IDLE_PICKUP_WAKE_BATCH);
    }
  });

  it("clamps the minute budget and never lets a batch exceed it", () => {
    expect(
      readIdleWakeBudgetSettings({ [IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV]: "3" }).perMinute,
    ).toBe(3);
    expect(
      readIdleWakeBudgetSettings({
        [IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV]: String(MAX_IDLE_PICKUP_WAKE_BUDGET_PER_MIN + 1),
      }).perMinute,
    ).toBe(DEFAULT_IDLE_PICKUP_WAKE_BUDGET_PER_MIN);
    expect(
      readIdleWakeBudgetSettings({
        [IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV]: "2",
        [IDLE_PICKUP_WAKE_BATCH_ENV]: "9",
      }),
    ).toEqual({ perMinute: 2, batch: 2 });
    expect(
      readIdleWakeBudgetSettings({
        [IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV]: "10",
        [IDLE_PICKUP_WAKE_BATCH_ENV]: "4",
      }),
    ).toEqual({ perMinute: 10, batch: 4 });
  });
});

describe("createIdleWakeBudget", () => {
  it("allows exactly the minute budget for one company and denies the next wake", () => {
    const budget = createIdleWakeBudget(() => ({ perMinute: 2, batch: 2 }));
    expect(budget.tryConsume("company-a")).toBe(true);
    expect(budget.remaining("company-a")).toBe(1);
    expect(budget.tryConsume("company-a")).toBe(true);
    expect(budget.remaining("company-a")).toBe(0);
    expect(budget.tryConsume("company-a")).toBe(false);
  });

  it("counts every company separately", () => {
    const budget = createIdleWakeBudget(() => ({ perMinute: 1, batch: 1 }));
    expect(budget.tryConsume("company-a")).toBe(true);
    expect(budget.tryConsume("company-a")).toBe(false);
    expect(budget.tryConsume("company-b")).toBe(true);
    expect(budget.remaining("company-b")).toBe(0);
  });

  it("opens a fresh window once the minute has passed", () => {
    let clock = 1_000_000;
    const budget = createIdleWakeBudget(() => ({ perMinute: 1, batch: 1 }), () => clock);
    expect(budget.tryConsume("company-a")).toBe(true);
    clock += IDLE_PICKUP_WAKE_WINDOW_MS - 1;
    expect(budget.tryConsume("company-a")).toBe(false);
    clock += 1;
    expect(budget.tryConsume("company-a")).toBe(true);
  });

  it("re-reads the budget so a raised ceiling applies without a restart", () => {
    let perMinute = 1;
    const budget = createIdleWakeBudget(() => ({ perMinute, batch: perMinute }));
    expect(budget.tryConsume("company-a")).toBe(true);
    expect(budget.tryConsume("company-a")).toBe(false);
    perMinute = 3;
    expect(budget.tryConsume("company-a")).toBe(true);
  });
});

describeEmbeddedPostgres("idle pickup under the company wake budget", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-idle-wake-budget-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(
    input: { companyId?: string; adapterConfig?: Record<string, unknown> } = {},
  ) {
    const companyId = input.companyId ?? randomUUID();
    const agentId = randomUUID();
    if (!input.companyId) {
      await db.insert(companies).values({
        id: companyId,
        name: "company-a",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: input.adapterConfig ?? {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  function fakeEnqueue() {
    return vi.fn(async () => ({ id: randomUUID() }));
  }

  it("denies the wake once the company budget is spent and says so", async () => {
    const { companyId, agentId } = await seedAgent();
    const budget = createIdleWakeBudget(() => ({ perMinute: 1, batch: 1 }));
    expect(budget.tryConsume(companyId)).toBe(true);
    const enqueueWakeup = fakeEnqueue();

    const result = await idlePickupForAgent(
      {
        db,
        budget,
        enqueueWakeup: enqueueWakeup as unknown as Parameters<typeof idlePickupForAgent>[0]["enqueueWakeup"],
      },
      { id: agentId, companyId },
    );

    expect(result.woken).toBe(0);
    expect(result.budgetSkipped).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("wakes again once the window has rolled over", async () => {
    const { companyId, agentId } = await seedAgent();
    let clock = 2_000_000;
    const budget = createIdleWakeBudget(() => ({ perMinute: 1, batch: 1 }), () => clock);
    const enqueueWakeup = fakeEnqueue();
    const deps = {
      db,
      budget,
      enqueueWakeup: enqueueWakeup as unknown as Parameters<typeof idlePickupForAgent>[0]["enqueueWakeup"],
    };

    const first = await idlePickupForAgent(deps, { id: agentId, companyId });
    const denied = await idlePickupForAgent(deps, { id: agentId, companyId });
    clock += IDLE_PICKUP_WAKE_WINDOW_MS;
    const allowedAgain = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(first.woken).toBe(1);
    expect(denied.woken).toBe(0);
    expect(denied.budgetSkipped).toBe(1);
    expect(allowedAgain.woken).toBe(1);
  });

  function sweeperDeps(input: {
    budget: ReturnType<typeof createIdleWakeBudget>;
    enqueueWakeup: ReturnType<typeof vi.fn>;
    env?: Record<string, string | undefined>;
    readLiveness?: () => Promise<ResolvedTeamLiveness>;
  }) {
    return {
      db,
      budget: input.budget,
      enqueueWakeup: input.enqueueWakeup as unknown as Parameters<typeof createIdlePickupSweeper>[0]["enqueueWakeup"],
      isAgentInvokable: vi.fn(async () => true),
      isAgentUnderMaintenance: vi.fn(async () => false),
      ...(input.env ? { env: input.env } : {}),
      ...(input.readLiveness ? { readLiveness: input.readLiveness } : {}),
    };
  }

  it("emits one pass's wakes for a company in a batch, not in one burst", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (let index = 0; index < 3; index += 1) await seedAgent({ companyId });
    const enqueueWakeup = fakeEnqueue();
    const budget = createIdleWakeBudget(() => ({ perMinute: 5, batch: 2 }));

    const sweeper = createIdlePickupSweeper(
      sweeperDeps({
        budget,
        enqueueWakeup,
        env: { [IDLE_PICKUP_WAKE_BATCH_ENV]: "2", [IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV]: "5" },
      }),
    );
    const result = await sweeper.sweep(new Date("2026-10-05T12:00:00Z"));

    expect(result.woken).toBe(2);
    expect(result.skippedOverBatch).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
  });

  it("does not let one company's batch delay another company's wake", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    for (const companyId of [companyA, companyB]) {
      await db.insert(companies).values({
        id: companyId,
        name: "company-a",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await seedAgent({ companyId: companyA });
    await seedAgent({ companyId: companyA });
    await seedAgent({ companyId: companyB });
    const enqueueWakeup = fakeEnqueue();
    const budget = createIdleWakeBudget(() => ({ perMinute: 5, batch: 1 }));

    const sweeper = createIdlePickupSweeper(
      sweeperDeps({
        budget,
        enqueueWakeup,
        env: { [IDLE_PICKUP_WAKE_BATCH_ENV]: "1", [IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV]: "5" },
      }),
    );
    const result = await sweeper.sweep(new Date("2026-10-05T12:00:00Z"));

    // Company A spends its whole batch on the first agent; its second agent
    // waits for the next pass, while company B is not affected at all.
    expect(result.woken).toBe(2);
    expect(result.skippedOverBatch).toBe(1);
  });

  it("holds the minute ceiling across passes of the same window", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (let index = 0; index < 2; index += 1) await seedAgent({ companyId });
    const enqueueWakeup = fakeEnqueue();
    let clock = 3_000_000;
    const budget = createIdleWakeBudget(() => ({ perMinute: 1, batch: 5 }), () => clock);

    const sweeper = createIdlePickupSweeper(
      sweeperDeps({
        budget,
        enqueueWakeup,
        env: { [IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV]: "1", [IDLE_PICKUP_WAKE_BATCH_ENV]: "5" },
      }),
    );
    const first = await sweeper.sweep(new Date("2026-10-05T12:00:00Z"));
    clock += 31_000;
    const second = await sweeper.sweep(new Date("2026-10-05T12:00:31Z"));
    clock += IDLE_PICKUP_WAKE_WINDOW_MS;
    const third = await sweeper.sweep(new Date("2026-10-05T12:02:00Z"));

    expect(first.woken).toBe(1);
    // The batch never exceeds the minute budget, so the second agent waits for
    // the next pass instead of spending an allowance the company does not have
    // yet.
    expect(first.skippedOverBatch).toBe(1);
    expect(first.budgetSkipped).toBe(0);
    expect(second.woken).toBe(0);
    expect(second.budgetSkipped).toBe(2);
    expect(second.skippedOverBatch).toBe(0);
    expect(third.woken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
  });
  /**
   * myrmidon(TEAM-LIVENESS-SETTINGS): the settings page decides, not the
   * environment.
   * These cases read the real contract (`resolveTeamLivenessSettings`) and hand
   * the resolved pair to the sweeper, exactly as heartbeat.ts does.
   */
  function liveness(stored: Record<string, unknown>, env: Record<string, string | undefined> = {}) {
    return async () => resolveTeamLivenessSettings({ stored, env });
  }

  it("obeys the stored settings over the environment", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (let index = 0; index < 3; index += 1) await seedAgent({ companyId });
    const enqueueWakeup = fakeEnqueue();
    const budget = createIdleWakeBudget(() => ({ perMinute: 5, batch: 5 }));

    const sweeper = createIdlePickupSweeper(
      sweeperDeps({
        budget,
        enqueueWakeup,
        // The environment would wake nothing at all and spends one wake a
        // minute; the operator saved "on", three a minute, two per pass.
        env: { [IDLE_PICKUP_ENABLED_ENV]: "0", [IDLE_PICKUP_WAKE_BUDGET_PER_MIN_ENV]: "1" },
        readLiveness: liveness({
          idlePickupEnabled: true,
          idlePickupWakeBudgetPerMin: 3,
          idlePickupWakeBatch: 2,
          idlePickupIntervalSec: 5,
        }),
      }),
    );
    const result = await sweeper.sweep(new Date("2026-10-05T12:00:00Z"));

    expect(result.woken).toBe(2);
    expect(result.skippedOverBatch).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
  });

  it("stops the pass when the stored settings switch the behaviour off", async () => {
    const { companyId } = await seedAgent();
    const enqueueWakeup = fakeEnqueue();
    const budget = createIdleWakeBudget(() => ({ perMinute: 5, batch: 5 }));

    const sweeper = createIdlePickupSweeper(
      sweeperDeps({
        budget,
        enqueueWakeup,
        // The environment still says "on": a stored "off" must win, otherwise
        // the switch on the settings page would not switch anything off.
        env: { [IDLE_PICKUP_ENABLED_ENV]: "1" },
        readLiveness: liveness({ idlePickupEnabled: false }),
      }),
    );
    const result = await sweeper.sweep(new Date("2026-10-05T12:00:00Z"));

    expect(result).toMatchObject({ agentsChecked: 0, woken: 0 });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("leaves an agent whose own card switched the behaviour off", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const optedOut = await seedAgent({
      companyId,
      adapterConfig: { [TEAM_LIVENESS_CARD_KEY]: { idlePickup: false } },
    });
    const participating = await seedAgent({ companyId });
    const enqueueWakeup = fakeEnqueue();
    const budget = createIdleWakeBudget(() => ({ perMinute: 5, batch: 5 }));

    const sweeper = createIdlePickupSweeper(
      sweeperDeps({
        budget,
        enqueueWakeup,
        readLiveness: liveness({ idlePickupEnabled: true, idlePickupWakeBudgetPerMin: 5, idlePickupWakeBatch: 5 }),
      }),
    );
    const result = await sweeper.sweep(new Date("2026-10-05T12:00:00Z"));

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([participating.issueId]);
    expect(result.issueIds).not.toContain(optedOut.issueId);
  });
});
