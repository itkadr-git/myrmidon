// myrmidon(CHAT-HOLD): a chat is never held, and an owner message always wakes.
//
// The seeded state is the production incident: a perpetual chat conversation
// whose run was cancelled by a host OOM; execution recovery closed it with
// `evidence.automaticRecovery.replay = "blocked"` and set the issue `blocked`;
// every later message was parked as `deferred_issue_execution` behind it and
// the owner only read "Your follow-up is queued". See chat-backed.ts.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Chat-hold test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../adapters/index.ts")>("../../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { createDurableChatWakeupRequest } from "../../services/durable-chat-wakeup.js";
import { settleUnrecoverableExecutions } from "../../services/execution-recovery-resolution.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { queueIssueAssignmentWakeup } from "../../services/issue-assignment-wakeup.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { LEGACY_RECOVERY_CAUSE } from "../../services/legacy-execution-recovery.js";
import { isChatOwnerMessageWake } from "./chat-backed.js";
import {
  chatNoticeLanguage,
  chatWaitNoticeApplies,
  chatWaitNoticeText,
  classifyAgentNotInvokable,
  classifyChatWait,
} from "./wait-notice.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const RUN_WAIT_MS = 60_000;
const TEST_TIMEOUT_MS = 150_000;
const OWNER = "owner-user";

describe("isChatOwnerMessageWake", () => {
  const message = {
    durableChatRequest: true,
    failedRunRetry: false,
    commentId: "c1",
    requestedByActorType: "user",
    requestedByActorId: "u1",
  };

  it("a durable inbound message from a linked person is an owner message", () => {
    expect(isChatOwnerMessageWake(message)).toBe(true);
  });

  it("a retry, an unlinked sender, a missing comment or a non-chat wake is not", () => {
    expect(isChatOwnerMessageWake({ ...message, failedRunRetry: true })).toBe(false);
    expect(isChatOwnerMessageWake({ ...message, requestedByActorType: "system" })).toBe(false);
    expect(isChatOwnerMessageWake({ ...message, commentId: null })).toBe(false);
    expect(isChatOwnerMessageWake({ ...message, requestedByActorId: null })).toBe(false);
    expect(isChatOwnerMessageWake({ ...message, durableChatRequest: false })).toBe(false);
  });
});

describe("wait notices", () => {
  it("names the recovery wait, a paused agent and a closed memory gate in plain Russian", () => {
    const recovery = classifyChatWait({
      status: "deferred_issue_execution",
      reason: "issue_assigned",
      payload: { executionWait: { reason: "execution_recovery" } },
    });
    expect(recovery).toBe("recovery");
    expect(chatWaitNoticeText("recovery", "ru")).toContain("прервался");
    expect(chatWaitNoticeText("agent_paused", "ru")).toContain("на паузе");
    expect(chatWaitNoticeText("host_memory", "ru")).toContain("памяти");
    expect(chatWaitNoticeText("host_memory", "ru")).toContain("15 секунд");
  });

  it("the same reason in English, and a not-started message asks to send it again", () => {
    expect(chatWaitNoticeText("agent_paused", "en")).toContain("paused");
    expect(chatWaitNoticeText("agent_paused", "ru", "not_started")).toContain("отправьте его ещё раз");
  });

  it("classifies a paused agent conflict and ignores unrelated errors", () => {
    expect(classifyAgentNotInvokable({ status: 409, details: { status: "paused" } })).toBe("agent_paused");
    expect(classifyAgentNotInvokable({ status: 409, details: { status: "terminated" } })).toBe("agent_unavailable");
    expect(classifyAgentNotInvokable({ status: 500, details: { status: "paused" } })).toBeNull();
    expect(classifyAgentNotInvokable(new Error("boom"))).toBeNull();
  });

  it("applies to the Telegram bridge only, in its language", () => {
    expect(chatWaitNoticeApplies("telegram")).toBe(true);
    expect(chatWaitNoticeApplies("slack")).toBe(false);
    expect(chatNoticeLanguage("telegram")).toBe("ru");
    expect(chatNoticeLanguage("slack")).toBe("en");
  });

  it("an unnamed wait keeps the vendor wording (no reason)", () => {
    expect(classifyChatWait({ status: "queued", reason: null, payload: null })).toBeNull();
  });
});

describeEmbeddedPostgres("a chat is never held and an owner message wakes (CHAT-HOLD)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-chat-hold-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    // A chat conversation only takes wakes while Agent Chat is on.
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 60_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => ["queued", "running", "scheduled_retry"].includes(run.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    mockAdapterExecute.mockClear();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options: { chat: boolean; status: string }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: OWNER,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: options.chat ? "chat" : "task",
        status: options.status,
        priority: "medium",
        assigneeAgentId: agentId,
        ...(options.chat
          ? { conversationAgentId: agentId, conversationUserId: OWNER, conversationState: "active" }
          : {}),
      })
      .returning();
    const issueId = issue!.id;
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      authorType: "agent",
      body: "note from the agent",
    });
    return { companyId, agentId, issueId, commentId };
  }

  async function seedStoppedRun(input: { companyId: string; agentId: string; issueId: string; commentId: string }) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        status: "cancelled",
        finishedAt: new Date(),
        contextSnapshot: { issueId: input.issueId, taskKey: input.issueId, wakeCommentId: input.commentId },
      })
      .returning();
    return run!;
  }

  async function ownerMessageWake(input: { companyId: string; agentId: string; issueId: string; commentId: string }) {
    // The owner's message arrives after the stopped turn.
    const messageId = randomUUID();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await db.insert(issueComments).values({
      id: messageId,
      companyId: input.companyId,
      issueId: input.issueId,
      authorUserId: OWNER,
      authorType: "user",
      body: "Please continue",
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: issue!,
      reason: "External chat message received",
      mutation: "chat_message_received",
      contextSource: "chat:telegram",
      requestedByActorType: "user",
      requestedByActorId: OWNER,
      taskKey: issue!.identifier,
      wakeCommentId: messageId,
      durableChatRequest: createDurableChatWakeupRequest({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
        commentId: messageId,
        requestedByActorType: "user",
        requestedByActorId: OWNER,
        requestedAt: new Date(),
        authorize: async () => {},
      }),
      rethrowOnError: true,
    });
  }

  async function runsFor(companyId: string, issueId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`));
  }

  async function waitForRun(companyId: string, issueId: string) {
    const deadline = Date.now() + RUN_WAIT_MS;
    while (Date.now() < deadline) {
      const runs = await runsFor(companyId, issueId);
      if (runs.some((run) => run.status !== "cancelled")) return runs;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return runsFor(companyId, issueId);
  }

  it("recovery of a stopped chat turn leaves no hold, and the next owner message starts a run", async () => {
    const fixture = await seed({ chat: true, status: "in_progress" });
    const run = await seedStoppedRun(fixture);
    await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, fixture.issueId));
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId: fixture.companyId,
        sourceIssueId: fixture.issueId,
        kind: "active_run_watchdog",
        ownerType: "board",
        returnOwnerAgentId: fixture.agentId,
        cause: LEGACY_RECOVERY_CAUSE,
        fingerprint: `legacy-execution:${run.id}`,
        evidence: { runId: run.id },
        nextAction: "Reconcile stopped work",
      })
      .returning();

    await settleUnrecoverableExecutions(db);

    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue!.status).toBe("in_review");
    expect(issue!.executionRunId).toBeNull();
    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(settled).toMatchObject({ status: "resolved", outcome: "cancelled" });
    expect(settled!.evidence.automaticRecovery).toMatchObject({ replay: "chat_continuation" });

    await ownerMessageWake(fixture);
    const runs = await waitForRun(fixture.companyId, fixture.issueId);
    expect(runs.filter((entry) => entry.id !== run.id).length, JSON.stringify(runs)).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it("reproduces the incident, then an owner message starts a run, clears the hold and is logged", async () => {
    const fixture = await seed({ chat: true, status: "todo" });
    const run = await seedStoppedRun(fixture);
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId: fixture.companyId,
        sourceIssueId: fixture.issueId,
        kind: "active_run_watchdog",
        status: "resolved",
        outcome: "blocked",
        cause: "uncertain_provider_action",
        fingerprint: randomUUID(),
        evidence: { runId: run.id, automaticRecovery: { replay: "blocked" } },
        nextAction: "Preserve recorded work without replay.",
      })
      .returning();

    // The incident: an automatic wake is parked on the hold, the way every
    // owner message was.
    const parked = await heartbeat.wakeup(fixture.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      requestedByActorType: "agent",
      requestedByActorId: fixture.agentId,
      payload: { issueId: fixture.issueId, commentId: fixture.commentId },
      contextSnapshot: { issueId: fixture.issueId, taskId: fixture.issueId, wakeReason: "issue_commented", commentId: fixture.commentId },
    });
    expect(parked).toBeNull();
    const [parkedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, fixture.agentId));
    expect(parkedWake?.status).toBe("deferred_issue_execution");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    // Recovery had set the chat blocked.
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.issueId));

    // The owner writes in the chat.
    await ownerMessageWake(fixture);

    const runs = await waitForRun(fixture.companyId, fixture.issueId);
    expect(runs.filter((entry) => entry.id !== run.id).length, JSON.stringify(runs)).toBeGreaterThan(0);

    const [cleared] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(cleared!.evidence.automaticRecovery).toMatchObject({
      replay: "chat_owner_message",
      replayClearedBy: OWNER,
      replayClearedByType: "user",
    });
    expect(cleared!.status).toBe("resolved");

    const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    expect(issue!.status).not.toBe("blocked");

    const log = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, fixture.companyId), eq(activityLog.entityId, fixture.issueId)));
    expect(
      log.some(
        (entry) =>
          entry.action === "issue.execution_recovery_settled" &&
          (entry.details as Record<string, unknown> | null)?.continuation === "chat_owner_message",
      ),
    ).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("an ordinary work issue keeps its hold: the same message is parked, not run", async () => {
    const fixture = await seed({ chat: false, status: "blocked" });
    const run = await seedStoppedRun(fixture);
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId: fixture.companyId,
        sourceIssueId: fixture.issueId,
        kind: "active_run_watchdog",
        status: "resolved",
        outcome: "blocked",
        cause: "uncertain_provider_action",
        fingerprint: randomUUID(),
        evidence: { runId: run.id, automaticRecovery: { replay: "blocked" } },
        nextAction: "Preserve recorded work without replay.",
      })
      .returning();

    await ownerMessageWake(fixture).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const [still] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    // Only a chat's hold is lifted by a message; an ordinary issue's stays.
    expect(still!.evidence.automaticRecovery).toMatchObject({ replay: "blocked" });
    expect((still!.evidence.automaticRecovery as Record<string, unknown>).replayClearedBy).toBeUndefined();
  }, TEST_TIMEOUT_MS);
});
