// server/src/myrmidon/wake-task-guard.myrmidon.test.ts
//
// myrmidon(1.6.5 F-26 T5): acceptance tests of the wake guard.
//
//   1. an automatic swarm wake with no issueId is closed before the adapter —
//      no run row, no adapter call (0 tokens);
//   2. a task with two consecutive stale automatic runs is not woken for
//      60 minutes (base 30, exponent 2^(n-1));
//   3. a new comment on the task lifts the cooling;
//   4. a manual wake of a user passes even when the issue is missing.
//
// Embedded Postgres harness follows heartbeat-idle-skip.myrmidon.test.ts.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  isTasklessAutomaticWake,
  isIssueCoolingDown,
  tasklessGateReason,
} from "./wake-task-guard.js";
import {
  resolveSwarmSettings,
  swarmCoolingPeriodMs,
} from "@paperclipai/shared";

// M3-style adapter spy: proves the gated wake never reaches the adapter.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "unused",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

describe("myrmidon(1.6.5 F-26 T5) taskless gate verdict (pure)", () => {
  it("flags the four automatic swarm reasons without an issueId", () => {
    for (const reason of ["swarm_matched", "idle_pickup", "issue_assigned", "swarm_claim_queue"]) {
      expect(isTasklessAutomaticWake({ source: "automation", reason, issueId: null })).toBe(true);
    }
  });

  it("passes manual wakes and automatic wakes that name a task", () => {
    expect(isTasklessAutomaticWake({ source: "manual", reason: "issue_assigned", issueId: null })).toBe(false);
    expect(isTasklessAutomaticWake({ source: "on_demand", reason: "swarm_matched", issueId: null })).toBe(false);
    expect(isTasklessAutomaticWake({ source: "automation", reason: "swarm_matched", issueId: "i-1" })).toBe(false);
    // A non-listed automatic reason (comment wake, monitor, timer) is untouched.
    expect(isTasklessAutomaticWake({ source: "automation", reason: "issue_commented", issueId: null })).toBe(false);
    expect(isTasklessAutomaticWake({ source: "automation", reason: "heartbeat_timer", issueId: null })).toBe(false);
  });

  it("cooling period: base*2^(n-1) clamped to the ceiling", () => {
    const s = { cooldownBaseMin: 30, cooldownCeilingHours: 24 };
    expect(swarmCoolingPeriodMs(1, s)).toBe(30 * 60_000);
    expect(swarmCoolingPeriodMs(2, s)).toBe(60 * 60_000);
    expect(swarmCoolingPeriodMs(3, s)).toBe(120 * 60_000);
    expect(swarmCoolingPeriodMs(21, s)).toBe(24 * 60 * 60_000);
  });

  it("settings resolve to the design defaults on garbage input", () => {
    const resolved = resolveSwarmSettings("not-an-object");
    expect(resolved.runWithoutTaskGate).toBe(true);
    expect(resolved.cooldownBaseMin).toBe(30);
    expect(resolved.cooldownCeilingHours).toBe(24);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("myrmidon(1.6.5 F-26 T5) wake guard against Postgres", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-wake-guard-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: "WG",
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true } },
      permissions: {},
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(status: "todo" | "in_progress" = "todo") {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Task ${issueId.slice(0, 4)}`,
      status,
      priority: "high",
    });
    return issueId;
  }

  async function seedAutoRun(
    issueId: string,
    overrides: { status?: string; livenessState?: string | null; finishedAt?: Date } = {},
  ) {
    const finishedAt = overrides.finishedAt ?? new Date();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "automation",
      status: overrides.status ?? "failed",
      livenessState: overrides.livenessState ?? null,
      contextSnapshot: { issueId, wakeReason: "idle_pickup", source: "automation" },
      contextIssueId: issueId,
      contextWakeReason: "idle_pickup",
      startedAt: new Date(finishedAt.getTime() - 60_000),
      finishedAt,
    });
  }

  it("gate: no issueId → no_task; missing issue → task_missing; manual wake always passes", async () => {
    expect(
      await tasklessGateReason(db, companyId, { source: "automation", reason: "swarm_matched", issueId: null }),
    ).toBe("no_task");

    const ghost = randomUUID();
    expect(
      await tasklessGateReason(db, companyId, { source: "automation", reason: "idle_pickup", issueId: ghost }),
    ).toBe("task_missing");

    expect(
      await tasklessGateReason(db, companyId, {
        source: "manual",
        reason: "issue_assigned",
        issueId: ghost,
        manualUserWake: true,
      }),
    ).toBeNull();

    const live = await seedIssue();
    expect(
      await tasklessGateReason(db, companyId, { source: "automation", reason: "swarm_matched", issueId: live }),
    ).toBeNull();
  });

  it("cooling: two stale runs → 60 min window; a comment lifts it", async () => {
    const issueId = await seedIssue("todo");
    const now = new Date();
    const settings = resolveSwarmSettings(undefined);

    await seedAutoRun(issueId, { status: "failed", finishedAt: new Date(now.getTime() - 5 * 60_000) });
    const afterOne = await isIssueCoolingDown(db, companyId, issueId, settings, now);
    expect(afterOne.cooling).toBe(true);
    expect(afterOne.staleCount).toBe(1);
    expect(afterOne.cooldownMin).toBe(30);

    // Pin the task so the second stale run is the last movement boundary.
    await db
      .update(issues)
      .set({ updatedAt: new Date(now.getTime() - 4 * 60_000) })
      .where(eq(issues.id, issueId));
    await seedAutoRun(issueId, { status: "failed", finishedAt: new Date(now.getTime() - 4 * 60_000) });
    const afterTwo = await isIssueCoolingDown(db, companyId, issueId, settings, now);
    expect(afterTwo.cooling).toBe(true);
    expect(afterTwo.staleCount).toBe(2);
    expect(afterTwo.cooldownMin).toBe(60);
    expect(afterTwo.nextWakeAt!.getTime()).toBeGreaterThan(now.getTime());

    // A comment after the last run is movement → cooling lifted.
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "still relevant, here is more context",
      authorAgentId: agentId,
      createdAt: new Date(now.getTime() - 60_000),
    });
    const afterComment = await isIssueCoolingDown(db, companyId, issueId, settings, now);
    expect(afterComment.cooling).toBe(false);
  });

  it("cooling: succeeded-without-advance on a todo task cools; an advanced run does not", async () => {
    const now = new Date();
    const settings = resolveSwarmSettings(undefined);

    const stuck = await seedIssue("todo");
    await seedAutoRun(stuck, {
      status: "succeeded",
      livenessState: "empty_response",
      finishedAt: new Date(now.getTime() - 10 * 60_000),
    });
    expect((await isIssueCoolingDown(db, companyId, stuck, settings, now)).cooling).toBe(true);

    const moving = await seedIssue("in_progress");
    await seedAutoRun(moving, {
      status: "succeeded",
      livenessState: "advanced",
      finishedAt: new Date(now.getTime() - 10 * 60_000),
    });
    expect((await isIssueCoolingDown(db, companyId, moving, settings, now)).cooling).toBe(false);
  });

  it("window expired → not cooling", async () => {
    const now = new Date();
    const settings = resolveSwarmSettings(undefined);
    const issueId = await seedIssue("todo");
    await seedAutoRun(issueId, { status: "failed", finishedAt: new Date(now.getTime() - 90 * 60_000) });
    // 90 min ago + 30 min window < now → expired.
    expect((await isIssueCoolingDown(db, companyId, issueId, settings, now)).cooling).toBe(false);
  });

  it("heartbeat seam: automatic swarm wake without issueId creates no run and never reaches the adapter", async () => {
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });

    const result = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "swarm_matched",
      payload: {},
    });
    expect(result).toBeNull();
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(
      eq(heartbeatRuns.contextWakeReason, "swarm_matched"),
    );
    expect(runs.length).toBe(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
});
