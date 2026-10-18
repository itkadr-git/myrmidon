// myrmidon(1.6.6 NOTIF-PREFS): service-level regression testing via
// heartbeatService.wakeup and enqueueWakeup, verifying that the production
// notification preferences gate suppresses muted event-shaped wakes at generation.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { notificationWakeAllowed } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Notification prefs test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeatService and enqueueWakeup notification preferences gate (service-level)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-notif-prefs-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(runtimeConfig: Record<string, unknown> = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-notif",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-notif",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-notif",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 },
        ...runtimeConfig,
      },
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task for notification prefs",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  it("suppresses wake and creates no wake/run when assignment notification class is disabled", async () => {
    const { agentId, issueId } = await seedAgent({
      notifications: { assignment: false },
    });

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "issue_assigned",
      reason: "issue_assigned",
      payload: { issueId },
    });

    expect(wakeResult).toBeNull();
    const wakeReqs = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeReqs).toHaveLength(0);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("suppresses wake when called via direct enqueueWakeup for disabled notification class", async () => {
    const { agentId, issueId } = await seedAgent({
      notifications: { assignment: false },
    });

    const wakeResult = await heartbeat.enqueueWakeup(agentId, {
      source: "assignment",
      triggerDetail: "issue_assigned",
      reason: "issue_assignment_recovery",
      payload: { issueId },
    });

    expect(wakeResult).toBeNull();
    const wakeReqs = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeReqs).toHaveLength(0);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("suppresses review wake reasons when review notification class is disabled", async () => {
    const { agentId, issueId } = await seedAgent({
      notifications: { review: false },
    });

    for (const reason of [
      "execution_review_requested",
      "execution_approval_requested",
      "execution_changes_requested",
    ] as const) {
      const wakeResult = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: reason,
        reason,
        payload: { issueId },
      });
      expect(wakeResult).toBeNull();
    }

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("mutes all configurable classes when the master switch is disabled", async () => {
    const { agentId, issueId } = await seedAgent({
      notifications: { enabled: false },
    });

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "comment",
      triggerDetail: "issue_comment_mentioned",
      reason: "issue_comment_mentioned",
      payload: { issueId },
    });

    expect(wakeResult).toBeNull();
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("allows wake through for an unmuted neighbor class", async () => {
    const { agentId, issueId } = await seedAgent({
      notifications: { assignment: false, mention: true },
    });

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "comment",
      triggerDetail: "issue_comment_mentioned",
      reason: "issue_comment_mentioned",
      payload: { issueId },
    });

    expect(wakeResult).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  it("allows wake through when notifications block is absent", async () => {
    const { agentId, issueId } = await seedAgent({});

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "issue_assigned",
      reason: "issue_assigned",
      payload: { issueId },
    });

    expect(wakeResult).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  it("bypasses notification filter when manualUserWake is requested", async () => {
    const { agentId, issueId } = await seedAgent({
      notifications: { assignment: false },
    });

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_assigned",
      manualUserWake: true,
      requestedByActorType: "user",
      requestedByActorId: "user-notif",
      payload: { issueId },
    });

    expect(wakeResult).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  it("passes unclassified reasons (e.g. timers, monitors) through even when master switch is off", async () => {
    const { agentId, issueId } = await seedAgent({
      notifications: { enabled: false },
    });

    const wakeResult = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "ping",
      reason: "timer_due",
      payload: { issueId },
    });

    expect(wakeResult).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("notificationWakeAllowed pure function helper gate", () => {
  it("delivers every class when the agent has no notifications block", () => {
    for (const reason of [
      "issue_assigned",
      "issue_assignment_recovery",
      "issue_comment_mentioned",
      "execution_review_requested",
      "execution_approval_requested",
      "execution_changes_requested",
    ]) {
      expect(notificationWakeAllowed({}, reason)).toBe(true);
      expect(notificationWakeAllowed(null, reason)).toBe(true);
      expect(notificationWakeAllowed(undefined, reason)).toBe(true);
    }
  });

  it("mutes only the classes the agent disabled", () => {
    const runtimeConfig = { notifications: { assignment: false, review: false } };
    expect(notificationWakeAllowed(runtimeConfig, "issue_assigned")).toBe(false);
    expect(notificationWakeAllowed(runtimeConfig, "issue_assignment_recovery")).toBe(false);
    expect(notificationWakeAllowed(runtimeConfig, "execution_review_requested")).toBe(false);
    expect(notificationWakeAllowed(runtimeConfig, "execution_approval_requested")).toBe(false);
    expect(notificationWakeAllowed(runtimeConfig, "execution_changes_requested")).toBe(false);
    expect(notificationWakeAllowed(runtimeConfig, "issue_comment_mentioned")).toBe(true);
  });

  it("mutes every class when the master switch is off", () => {
    const runtimeConfig = { notifications: { enabled: false } };
    for (const reason of [
      "issue_assigned",
      "issue_comment_mentioned",
      "execution_review_requested",
    ]) {
      expect(notificationWakeAllowed(runtimeConfig, reason)).toBe(false);
    }
  });

  it("passes reasons that belong to no configurable class", () => {
    const runtimeConfig = { notifications: { enabled: false } };
    for (const reason of [
      "issue_commented",
      "timer_due",
      "monitor_due",
      "blockers_resolved",
      "idle_pickup",
      "transient_failure_retry",
      null,
      undefined,
    ]) {
      expect(notificationWakeAllowed(runtimeConfig, reason)).toBe(true);
    }
  });

  it("falls back to per-field defaults on malformed blocks", () => {
    expect(notificationWakeAllowed({ notifications: "off" }, "issue_assigned")).toBe(true);
    expect(notificationWakeAllowed({ notifications: { assignment: "false" } }, "issue_assigned")).toBe(true);
    expect(notificationWakeAllowed({ notifications: { assignment: false, bogus: true } }, "issue_assigned")).toBe(false);
    expect(notificationWakeAllowed({ notifications: { assignment: false, bogus: true } }, "issue_comment_mentioned")).toBe(true);
  });
});
