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
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
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
  decideIssueCooling,
  isRealTaskMovement,
  readSwarmSettings,
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

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>(
    "../adapters/index.js",
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

describe("myrmidon(1.6.5 F-26 T5) cooling decision (pure, system actors excluded)", () => {
  const settings = { cooldownBaseMin: 30, cooldownCeilingHours: 24 };
  const now = new Date("2026-10-09T12:00:00Z");
  const finishedAt = new Date(now.getTime() - 10 * 60_000);
  const run = {
    agentId: "agent-1",
    status: "failed",
    livenessState: null,
    finishedAt,
    startedAt: new Date(finishedAt.getTime() - 60_000),
    createdAt: new Date(finishedAt.getTime() - 60_000),
  };
  const after = finishedAt.getTime() + 60_000;
  const decide = (moves: Parameters<typeof decideIssueCooling>[0]["moves"]) =>
    decideIssueCooling({ issueStatus: "todo", runs: [run], moves, settings, now });

  it("no movement -> cooling", () => {
    expect(decide([]).cooling).toBe(true);
  });

  it("system issue.updated / system comment / the stale run's own agent after finishedAt do NOT lift cooling", () => {
    expect(decide([{ at: after, actorType: "system", actorId: "execution-recovery" }]).cooling).toBe(true);
    expect(decide([{ at: after, actorType: "system", actorId: null }]).cooling).toBe(true);
    expect(decide([{ at: after, actorType: "agent", actorId: "agent-1" }]).cooling).toBe(true);
  });

  it("a user or another agent lifts cooling", () => {
    expect(decide([{ at: after, actorType: "user", actorId: "u1" }]).cooling).toBe(false);
    expect(decide([{ at: after, actorType: "agent", actorId: "agent-2" }]).cooling).toBe(false);
  });

  it("isRealTaskMovement classifies actors", () => {
    expect(isRealTaskMovement({ at: 1, actorType: "system", actorId: "x" }, "a")).toBe(false);
    expect(isRealTaskMovement({ at: 1, actorType: "user", actorId: "u" }, "a")).toBe(true);
    expect(isRealTaskMovement({ at: 1, actorType: "agent", actorId: "a" }, "a")).toBe(false);
    expect(isRealTaskMovement({ at: 1, actorType: "agent", actorId: "b" }, "a")).toBe(true);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("myrmidon(1.6.5 F-26 T5) wake guard against Postgres", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let otherAgentId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-wake-guard-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    otherAgentId = randomUUID();
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
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "agent-b",
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
    // Finishing a run that held the task goes through releaseIssueExecution,
    // which bumps issues.updatedAt AFTER finishedAt. Mirror that here: the
    // cooling must not read it as task movement.
    await db
      .update(issues)
      .set({ updatedAt: new Date(finishedAt.getTime() + 1_000) })
      .where(eq(issues.id, issueId));
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
      authorAgentId: otherAgentId,
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

  it("cooling: movement between runs resets the exponent; cancelled runs do not cool; real activity lifts", async () => {
    const now = new Date();
    const settings = resolveSwarmSettings(undefined);

    // failed, then a comment, then failed again: n restarts at 1 (30 min).
    const reset = await seedIssue("todo");
    await seedAutoRun(reset, { status: "failed", finishedAt: new Date(now.getTime() - 20 * 60_000) });
    await db.insert(issueComments).values({
      companyId,
      issueId: reset,
      body: "new context between runs",
      authorAgentId: otherAgentId,
      createdAt: new Date(now.getTime() - 15 * 60_000),
    });
    await seedAutoRun(reset, { status: "failed", finishedAt: new Date(now.getTime() - 5 * 60_000) });
    const resetStatus = await isIssueCoolingDown(db, companyId, reset, settings, now);
    expect(resetStatus.cooling).toBe(true);
    expect(resetStatus.staleCount).toBe(1);
    expect(resetStatus.cooldownMin).toBe(30);

    // System cancellations are not stale runs.
    const cancelled = await seedIssue("todo");
    await seedAutoRun(cancelled, { status: "cancelled", finishedAt: new Date(now.getTime() - 5 * 60_000) });
    expect((await isIssueCoolingDown(db, companyId, cancelled, settings, now)).cooling).toBe(false);

    // A status/assignee change logged as activity lifts the window, even
    // though the release-style updatedAt bump alone never does.
    const changed = await seedIssue("todo");
    await seedAutoRun(changed, { status: "failed", finishedAt: new Date(now.getTime() - 10 * 60_000) });
    expect((await isIssueCoolingDown(db, companyId, changed, settings, now)).cooling).toBe(true);
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "user-a",
      action: "issue.updated",
      entityType: "issue",
      entityId: changed,
      createdAt: new Date(now.getTime() - 2 * 60_000),
    });
    expect((await isIssueCoolingDown(db, companyId, changed, settings, now)).cooling).toBe(false);
  });

  it("cooling: system activity and system comments after finishedAt keep cooling (idle_pickup -> blocked loop)", async () => {
    const now = new Date();
    const settings = resolveSwarmSettings(undefined);
    const issueId = await seedIssue("todo");
    await seedAutoRun(issueId, { status: "failed", finishedAt: new Date(now.getTime() - 10 * 60_000) });
    // execution-recovery moves the task to blocked after the stale run.
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "execution-recovery",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      createdAt: new Date(now.getTime() - 5 * 60_000),
    });
    // A system comment (no user, no agent author).
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "workspace runtime notice",
      createdAt: new Date(now.getTime() - 4 * 60_000),
    });
    // The stale run's own agent commenting afterwards is not movement either.
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "own agent follow-up",
      authorAgentId: agentId,
      createdAt: new Date(now.getTime() - 3 * 60_000),
    });
    expect((await isIssueCoolingDown(db, companyId, issueId, settings, now)).cooling).toBe(true);
    // Green side: a user comment on the same task lifts it.
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "owner context",
      authorUserId: "user-a",
      createdAt: new Date(now.getTime() - 2 * 60_000),
    });
    expect((await isIssueCoolingDown(db, companyId, issueId, settings, now)).cooling).toBe(false);
  });

  it("window expired → not cooling", async () => {
    const now = new Date();
    const settings = resolveSwarmSettings(undefined);
    const issueId = await seedIssue("todo");
    await seedAutoRun(issueId, { status: "failed", finishedAt: new Date(now.getTime() - 90 * 60_000) });
    // 90 min ago + 30 min window < now → expired.
    expect((await isIssueCoolingDown(db, companyId, issueId, settings, now)).cooling).toBe(false);
  });

  // myrmidon(1.6.5 SWARM-PANEL-COOLING, OPE-6894) — red side: the value the
  // "Task cooling" block saves into `general.swarm` is the one rule the guard
  // reads back through `readSwarmSettings`, and it changes the wake decision.
  it("a cooldown saved through the settings row changes the guard's decision", async () => {
    const issueId = await seedIssue("todo");
    const now = new Date();
    // one stale automatic run 20 minutes ago: with the DEFAULT base (30 min)
    // the task is still cooling — the wake must not fire.
    await seedAutoRun(issueId, { status: "failed", finishedAt: new Date(now.getTime() - 20 * 60_000) });
    expect(
      (await isIssueCoolingDown(db, companyId, issueId, resolveSwarmSettings(undefined), now)).cooling,
    ).toBe(true);

    // what PATCH /api/instance/settings/general stores for the cooling block
    // (the panel's save path): base 10 minutes.
    await db.insert(instanceSettings).values({
      general: { swarm: { cooldownBaseMin: 10, cooldownCeilingHours: 24, runWithoutTaskGate: true } },
      experimental: {},
    });

    const saved = await readSwarmSettings(db);
    expect(saved.cooldownBaseMin).toBe(10);
    // the same task, the same clock: the saved value lifted the window, so
    // the wake goes through (not cooling).
    expect((await isIssueCoolingDown(db, companyId, issueId, saved, now)).cooling).toBe(false);
  });

  it("heartbeat seam: automatic swarm wake without issueId creates no run and never reaches the adapter", async () => {
    const { heartbeatService } = await import("../services/heartbeat.js");
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
