import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  issueWorkProducts,
} from "@myrmidon/db";
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
  createInProgressIdleWakeSweeper,
  IN_PROGRESS_NO_RUN_ACTIVITY_ACTION,
  IN_PROGRESS_NO_RUN_REASON,
  isHeadCiInProgress,
  isIdleLongEnough,
} from "../myrmidon/in-progress-idle-wake.ts";
import {
  DEFAULT_IN_PROGRESS_IDLE_WAKE_MINUTES,
  mergeRunPrioritySettings,
  normalizeRunPrioritySettings,
  readRunPriorityFromEnv,
} from "@myrmidon/shared";

// OPE-13202: an in_progress task whose executor has no run and no wake for N
// minutes is woken by the board itself (reason in_progress_no_run).
const MIN = 60_000;
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("in-progress idle wake: setting and pure rules", () => {
  it("defaults to 20 minutes, is read from the stored row and can be switched off", () => {
    expect(DEFAULT_IN_PROGRESS_IDLE_WAKE_MINUTES).toBe(20);
    expect(readRunPriorityFromEnv({}).inProgressIdleWakeMinutes).toBe(20);
    expect(readRunPriorityFromEnv({ MYRMIDON_IN_PROGRESS_IDLE_WAKE_MIN: "7" }).inProgressIdleWakeMinutes).toBe(7);
    expect(normalizeRunPrioritySettings({ inProgressIdleWakeMinutes: 35 }).inProgressIdleWakeMinutes).toBe(35);
    expect(normalizeRunPrioritySettings({}).inProgressIdleWakeMinutes).toBe(20);
    const base = readRunPriorityFromEnv({});
    expect(mergeRunPrioritySettings(base, { inProgressIdleWakeMinutes: 0 }).inProgressIdleWakeMinutes).toBe(0);
  });

  it("idle clock: strictly after the window, never when the setting is 0", () => {
    const now = new Date("2026-11-15T10:00:00Z");
    expect(isIdleLongEnough(new Date(now.getTime() - 21 * MIN), now, 20)).toBe(true);
    expect(isIdleLongEnough(new Date(now.getTime() - 19 * MIN), now, 20)).toBe(false);
    expect(isIdleLongEnough(new Date(now.getTime() - 500 * MIN), now, 0)).toBe(false);
  });

  it("head CI counts as running only for queued / in_progress / pending", () => {
    expect(isHeadCiInProgress({ activeCi: { status: "in_progress" } })).toBe(true);
    expect(isHeadCiInProgress({ activeCi: { status: "Queued" } })).toBe(true);
    expect(isHeadCiInProgress({ activeCi: { status: "pending" } })).toBe(true);
    expect(isHeadCiInProgress({ activeCi: { status: "completed" } })).toBe(false);
    expect(isHeadCiInProgress({ activeCi: null })).toBe(false);
    // CI of the current head holds the wake, CI of a superseded head does not.
    expect(isHeadCiInProgress({ headSha: "new", activeCi: { status: "in_progress", headSha: "new" } })).toBe(true);
    expect(isHeadCiInProgress({ headSha: "new", activeCi: { status: "in_progress", headSha: "old" } })).toBe(false);
    expect(isHeadCiInProgress(null)).toBe(false);
  });
});

describeEmbeddedPostgres("in-progress idle wake sweep (OPE-13202)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-in-progress-idle-wake-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(issueWorkProducts);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(role = "engineer") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role,
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: { companyId: string; agentId: string; idleMinutes: number; status?: string }) {
    const id = randomUUID();
    const at = new Date(Date.now() - input.idleMinutes * MIN);
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: "Task in progress",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.agentId,
      createdAt: at,
      updatedAt: at,
    });
    return id;
  }

  async function seedPullRequest(input: {
    companyId: string;
    issueId: string;
    metadata: Record<string, unknown>;
  }) {
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId: input.companyId,
      issueId: input.issueId,
      type: "pull_request",
      provider: "github",
      title: "PR",
      status: "open",
      metadata: input.metadata,
    });
  }

  function makeSweeper(overrides: { minutes?: number; enqueue?: () => Promise<unknown> } = {}) {
    const enqueueWakeup = vi.fn(overrides.enqueue ?? (async () => ({ id: randomUUID() })));
    const logActivity = vi.fn(async () => undefined);
    const sweeper = createInProgressIdleWakeSweeper({
      db,
      readIdleMinutes: () => overrides.minutes ?? 20,
      enqueueWakeup: enqueueWakeup as never,
      isAgentInvokable: async () => true,
      isAgentUnderMaintenance: async () => false,
      logActivity,
    });
    return { sweeper, enqueueWakeup, logActivity };
  }

  it("wakes the executor of a task idle for 21 minutes, with the reason, and records it in the feed", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, idleMinutes: 21 });
    const { sweeper, enqueueWakeup, logActivity } = makeSweeper();

    const result = await sweeper.sweep(new Date());

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: IN_PROGRESS_NO_RUN_REASON,
        payload: expect.objectContaining({ issueId }),
        contextSnapshot: expect.objectContaining({ issueId, wakeReason: IN_PROGRESS_NO_RUN_REASON }),
      }),
    );
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: IN_PROGRESS_NO_RUN_ACTIVITY_ACTION,
        entityType: "issue",
        entityId: issueId,
        details: expect.objectContaining({ reason: IN_PROGRESS_NO_RUN_REASON, thresholdMinutes: 20 }),
      }),
    );
  });

  it("does not wake a task that has been idle for less than the window", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId, idleMinutes: 5 });
    const { sweeper, enqueueWakeup } = makeSweeper();

    const result = await sweeper.sweep(new Date());

    expect(result.woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not repeat the wake five minutes later (once per window per task)", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId, idleMinutes: 21 });
    const { sweeper, enqueueWakeup } = makeSweeper();
    const start = Date.now();

    expect((await sweeper.sweep(new Date(start))).woken).toBe(1);
    expect((await sweeper.sweep(new Date(start + 5 * MIN))).woken).toBe(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    // Past the window the net may try again.
    expect((await sweeper.sweep(new Date(start + 21 * MIN))).woken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
  });

  it("does not retry a wake that admission refused before the window is over", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId, idleMinutes: 21 });
    const { sweeper, enqueueWakeup } = makeSweeper({ enqueue: async () => null });
    const start = Date.now();

    expect((await sweeper.sweep(new Date(start))).woken).toBe(0);
    expect((await sweeper.sweep(new Date(start + 5 * MIN))).woken).toBe(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("does not wake while the CI of the PR head is running", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, idleMinutes: 21 });
    await seedPullRequest({
      companyId,
      issueId,
      metadata: { headSha: "abc123", activeCi: { status: "in_progress", headSha: "abc123" } },
    });
    const { sweeper, enqueueWakeup } = makeSweeper();

    expect((await sweeper.sweep(new Date())).woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("wakes when the running CI belongs to an older head than the current one", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, idleMinutes: 21 });
    await seedPullRequest({
      companyId,
      issueId,
      metadata: { headSha: "new-head", activeCi: { status: "in_progress", headSha: "old-head" } },
    });
    const { sweeper, enqueueWakeup } = makeSweeper();

    expect((await sweeper.sweep(new Date())).woken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("does not wake while the CI of the current head runs (matching SHA)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, idleMinutes: 21 });
    await seedPullRequest({
      companyId,
      issueId,
      metadata: { headSha: "same", activeCi: { status: "queued", headSha: "same" } },
    });
    const { sweeper, enqueueWakeup } = makeSweeper();

    expect((await sweeper.sweep(new Date())).woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("is not starved by 200 older excluded tasks: the eligible task behind them is woken", async () => {
    const { companyId, agentId: busyAgentId } = await seedAgent();
    const freeAgentId = randomUUID();
    await db.insert(agents).values({
      id: freeAgentId,
      companyId,
      name: "agent-free",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // The busy executor has a live run, so all its 200 older tasks are excluded.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: busyAgentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: {},
    });
    const oldAt = new Date(Date.now() - 600 * MIN);
    await db.insert(issues).values(
      Array.from({ length: 200 }, (_, i) => ({
        id: randomUUID(),
        companyId,
        title: `Excluded ${i}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: busyAgentId,
        createdAt: oldAt,
        updatedAt: new Date(oldAt.getTime() + i * 1000),
      })),
    );
    const eligibleId = await seedIssue({ companyId, agentId: freeAgentId, idleMinutes: 30 });
    const { sweeper, enqueueWakeup } = makeSweeper();

    const result = await sweeper.sweep(new Date());

    expect(result.issueIds).toEqual([eligibleId]);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(freeAgentId, expect.anything());
  }, 60_000);

  it("keyset paging does not stall when more than a page of tasks share one updatedAt", async () => {
    const { companyId, agentId: busyAgentId } = await seedAgent();
    const freeAgentId = randomUUID();
    await db.insert(agents).values({
      id: freeAgentId,
      companyId,
      name: "agent-free",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: busyAgentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: {},
    });
    // One instant with sub-millisecond digits, shared by all 201 tasks; the ids
    // order the eligible task last, so it is the 201st row of the walk.
    const sameAt = new Date(Date.now() - 600 * MIN);
    const pad = (n: number) => n.toString(16).padStart(12, "0");
    await db.insert(issues).values(
      Array.from({ length: 200 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${pad(i)}`,
        companyId,
        title: `Excluded ${i}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: busyAgentId,
        createdAt: sameAt,
        updatedAt: sameAt,
      })),
    );
    const eligibleId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.insert(issues).values({
      id: eligibleId,
      companyId,
      title: "Eligible",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: freeAgentId,
      createdAt: sameAt,
      updatedAt: sameAt,
    });
    const { sweeper, enqueueWakeup } = makeSweeper();

    const result = await sweeper.sweep(new Date());

    expect(result.issueIds).toEqual([eligibleId]);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(freeAgentId, expect.anything());
  }, 60_000);

  it("wakes once the head CI has finished", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, idleMinutes: 21 });
    await seedPullRequest({ companyId, issueId, metadata: { headSha: "abc123", activeCi: null } });
    const { sweeper } = makeSweeper();

    expect((await sweeper.sweep(new Date())).woken).toBe(1);
  });

  it("does not wake an executor that already has a live run", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, idleMinutes: 21 });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: { issueId },
    });
    const { sweeper, enqueueWakeup } = makeSweeper();

    expect((await sweeper.sweep(new Date())).woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not wake a task whose own run finished inside the window", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, idleMinutes: 40 });
    const finishedAt = new Date(Date.now() - 5 * MIN);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "automation",
      contextSnapshot: { issueId },
      startedAt: new Date(finishedAt.getTime() - MIN),
      finishedAt,
    });
    const { sweeper, enqueueWakeup } = makeSweeper();

    expect((await sweeper.sweep(new Date())).woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not wake a task at the runs-without-commit cap", async () => {
    const { companyId, agentId } = await seedAgent("engineer");
    const issueId = await seedIssue({ companyId, agentId, idleMinutes: 90 });
    await seedPullRequest({ companyId, issueId, metadata: { headSha: "same-head", activeCi: null } });
    for (let i = 0; i < 4; i += 1) {
      const at = new Date(Date.now() - (80 - i * 5) * MIN);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "automation",
        contextSnapshot: { issueId },
        resultJson: { prHeadSha: "same-head" },
        createdAt: at,
        startedAt: at,
        finishedAt: new Date(at.getTime() + MIN),
      });
    }
    const { sweeper, enqueueWakeup } = makeSweeper();

    expect((await sweeper.sweep(new Date())).woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("ignores tasks that are not in_progress and does nothing when the setting is 0", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId, idleMinutes: 60, status: "todo" });
    await seedIssue({ companyId, agentId, idleMinutes: 60, status: "in_review" });
    const { sweeper, enqueueWakeup } = makeSweeper();
    expect((await sweeper.sweep(new Date())).woken).toBe(0);

    await seedIssue({ companyId, agentId, idleMinutes: 60 });
    const off = makeSweeper({ minutes: 0 });
    expect((await off.sweeper.sweep(new Date())).woken).toBe(0);
    expect(off.enqueueWakeup).not.toHaveBeenCalled();
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});
