import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  goals,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  projects,
  type Db,
} from "@myrmidon/db";
import {
  deriveOriginatingActor,
  deriveResponsibleActor,
} from "@myrmidon/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import {
  resolveAgentHeadId,
  resolveCompanyDomainHeadId,
  resolveResponsibleHeadAgentId,
} from "./responsible-head.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("RESPONSIBLE-HEAD acceptance criteria and behavioral tests", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  let companyId: string;
  let admAgentId: string;
  let leadAgentId: string;
  let engAgentId: string;
  let pausedAgentId: string;
  let projectId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("resp-head-int-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    admAgentId = randomUUID();
    leadAgentId = randomUUID();
    engAgentId = randomUUID();
    pausedAgentId = randomUUID();
    projectId = randomUUID();
    ownerUserId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Resp Head Co",
      issuePrefix: "RHC",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(companyMemberships).values({
      id: randomUUID(),
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });

    await db.insert(agents).values([
      {
        id: admAgentId,
        companyId,
        name: "adm",
        role: "lead",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pausedAgentId,
        companyId,
        name: "Wiki Maintainer",
        role: "librarian",
        status: "paused",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: leadAgentId,
        companyId,
        name: "lead-dev",
        role: "lead",
        status: "active",
        reportsTo: admAgentId,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: engAgentId,
        companyId,
        name: "eng-23",
        role: "engineer",
        status: "active",
        reportsTo: leadAgentId,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Core",
      leadAgentId: leadAgentId,
    });
  });

  afterAll(async () => {
    if (tempDb) {
      await tempDb.cleanup();
    }
  });

  describe("1. Responsible Agent Resolution (real DB SQL)", () => {
    it("assignee with reports_to hierarchy resolves to top-level active direction head (adm)", async () => {
      const head = await resolveAgentHeadId(db, companyId, engAgentId);
      expect(head).toBe(admAgentId);
    });

    it("paused root agent returns null and is not selected as head", async () => {
      const head = await resolveAgentHeadId(db, companyId, pausedAgentId);
      expect(head).toBeNull();
    });

    it("unassigned task resolves to project lead root", async () => {
      const head = await resolveResponsibleHeadAgentId(db, companyId, {
        projectId,
      });
      expect(head).toBe(admAgentId);
    });

    it("unassigned task without project resolves to company domain head (adm)", async () => {
      const head = await resolveCompanyDomainHeadId(db, companyId);
      expect(head).toBe(admAgentId);
    });
  });

  describe("2. Issue card & attribution", () => {
    it("bot task has responsible agent and no responsible user", () => {
      const botIssue = {
        responsibleAgentId: admAgentId,
        responsibleUserId: null,
        createdByUserId: null,
        createdByAgentId: engAgentId,
      };

      const actor = deriveResponsibleActor(botIssue);
      expect(actor).toEqual({ kind: "agent", id: admAgentId });

      const originator = deriveOriginatingActor(botIssue);
      expect(originator).toEqual({ kind: "agent", id: engAgentId });
    });

    it("owner created task has responsible user (owner) and no responsible agent", () => {
      const ownerIssue = {
        responsibleAgentId: null,
        responsibleUserId: "user-owner",
        createdByUserId: "user-owner",
        createdByAgentId: null,
      };

      const actor = deriveResponsibleActor(ownerIssue);
      expect(actor).toEqual({ kind: "user", id: "user-owner" });

      const originator = deriveOriginatingActor(ownerIssue);
      expect(originator).toEqual({ kind: "user", id: "user-owner" });
    });
  });

  describe("3. Questions / Confirmation routing (behavioral issueThreadInteractionService)", () => {
    it("auto-addresses interaction without addressee from subordinate agent to responsibleAgentId", async () => {
      const issueId = randomUUID();
      const goalId = randomUUID();
      const runId = randomUUID();

      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Test goal",
        level: "task",
        status: "active",
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        goalId,
        title: "Test issue for interaction routing",
        status: "in_progress",
        priority: "medium",
        responsibleAgentId: admAgentId,
        assigneeAgentId: engAgentId,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: engAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
      });

      const svc = issueThreadInteractionService(db);
      const input = {
        kind: "ask_user_questions" as const,
        idempotencyKey: "test:routing:subordinate-to-head",
        sourceRunId: runId,
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "q1",
              prompt: "Need guidance from head",
              selectionMode: "single" as const,
              options: [{ id: "ok", label: "OK" }],
            },
          ],
        },
      };

      const interaction = await svc.create(
        { id: issueId, companyId },
        input,
        { agentId: engAgentId },
      );

      expect(interaction.addresseeAgentId).toBe(admAgentId);
      expect(interaction.addresseeUserId).toBeNull();

      // Idempotency test: repeating the exact same create call returns the existing interaction without error
      const secondCall = await svc.create(
        { id: issueId, companyId },
        input,
        { agentId: engAgentId },
      );
      expect(secondCall.id).toBe(interaction.id);
      expect(secondCall.addresseeAgentId).toBe(admAgentId);
    });

    it("does not self-address when head agent creates an interaction without addressee", async () => {
      const issueId = randomUUID();
      const goalId = randomUUID();
      const runId = randomUUID();

      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Head task",
        level: "task",
        status: "active",
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        goalId,
        title: "Head owned task",
        status: "in_progress",
        priority: "medium",
        responsibleAgentId: admAgentId,
        assigneeAgentId: admAgentId,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: admAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
      });

      const svc = issueThreadInteractionService(db);
      const input = {
        kind: "ask_user_questions" as const,
        idempotencyKey: "test:routing:head-no-self-address",
        sourceRunId: runId,
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "q2",
              prompt: "Head question for human",
              selectionMode: "single" as const,
              options: [{ id: "ok", label: "OK" }],
            },
          ],
        },
      };

      const interaction = await svc.create(
        { id: issueId, companyId },
        input,
        { agentId: admAgentId },
      );

      // Must not target self: addresseeAgentId remains null
      expect(interaction.addresseeAgentId).toBeNull();
    });

    it("does not auto-address to paused head agent", async () => {
      const issueId = randomUUID();
      const goalId = randomUUID();
      const runId = randomUUID();

      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Goal with paused head",
        level: "task",
        status: "active",
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        goalId,
        title: "Task with paused head",
        status: "in_progress",
        priority: "medium",
        responsibleAgentId: pausedAgentId,
        assigneeAgentId: engAgentId,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: engAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
      });

      const svc = issueThreadInteractionService(db);
      const input = {
        kind: "ask_user_questions" as const,
        idempotencyKey: "test:routing:paused-head-fallback",
        sourceRunId: runId,
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "q3",
              prompt: "Paused head question",
              selectionMode: "single" as const,
              options: [{ id: "ok", label: "OK" }],
            },
          ],
        },
      };

      const interaction = await svc.create(
        { id: issueId, companyId },
        input,
        { agentId: engAgentId },
      );

      // Does not address paused agent; addresseeAgentId remains null
      expect(interaction.addresseeAgentId).toBeNull();
    });
  });

  describe("4. Wakeup and queued dispatch on unaddressed subordinate interaction", () => {
    it("wakes direction head with interaction_pending when subordinate creates unaddressed question", async () => {
      const issueId = randomUUID();
      const goalId = randomUUID();
      const runId = randomUUID();

      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Goal for wakeup test",
        level: "task",
        status: "active",
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        goalId,
        title: "Issue with unaddressed question needing head wakeup",
        status: "in_progress",
        priority: "medium",
        responsibleAgentId: admAgentId,
        assigneeAgentId: engAgentId,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: engAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
      });

      const svc = issueThreadInteractionService(db);
      const input = {
        kind: "ask_user_questions" as const,
        idempotencyKey: `test:wakeup:subordinate-to-head:${issueId}`,
        sourceRunId: runId,
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "q_wake",
              prompt: "Do we deploy now?",
              selectionMode: "single" as const,
              options: [{ id: "yes", label: "Yes" }],
            },
          ],
        },
      };

      const interaction = await svc.create(
        { id: issueId, companyId },
        input,
        { agentId: engAgentId },
      );

      // RESPONSIBLE-HEAD auto-addresses to domain head (adm)
      expect(interaction.addresseeAgentId).toBe(admAgentId);
      expect(interaction.addresseeUserId).toBeNull();

      // Guardrail: prior to waking addressee, no queued run exists for the head agent
      const preWakeRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, admAgentId),
            eq(heartbeatRuns.status, "queued"),
          ),
        );
      expect(preWakeRuns).toHaveLength(0);

      // Waking the resolved addressee agent on interaction creation
      const heartbeat = heartbeatService(db);
      const wakeResult = await heartbeat.wakeup(interaction.addresseeAgentId!, {
        source: "automation",
        triggerDetail: "system",
        reason: "interaction_pending",
        payload: {
          issueId,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
        },
        idempotencyKey: `interaction-pending:${interaction.id}`,
        requestedByActorType: "agent",
        requestedByActorId: engAgentId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          wakeReason: "interaction_pending",
          source: "issue.interaction.created",
        },
      });

      // Head agent was idle: directly queued
      expect(wakeResult).not.toBeNull();
      expect(wakeResult?.status).toBe("queued");

      const headRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, admAgentId),
            eq(heartbeatRuns.status, "queued"),
          ),
        );

      expect(headRuns.length).toBeGreaterThanOrEqual(1);
      const targetRun = headRuns.find(
        (r) => (r.contextSnapshot as any)?.interactionId === interaction.id,
      );
      expect(targetRun).toBeDefined();
      expect(targetRun?.responsibleUserId).toBe(ownerUserId);
      expect((targetRun?.contextSnapshot as any)?.issueId).toBe(issueId);
      expect((targetRun?.contextSnapshot as any)?.wakeReason).toBe("interaction_pending");

      // Verify no queued runs for owner or engineer
      const allQueuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.status, "queued"),
          ),
        );
      expect(allQueuedRuns.every((r) => r.agentId === admAgentId)).toBe(true);
    });

    it("wakes direction head with interaction_pending for unaddressed request_confirmation", async () => {
      const issueId = randomUUID();
      const goalId = randomUUID();
      const runId = randomUUID();

      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Confirmation goal",
        level: "task",
        status: "active",
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        goalId,
        title: "Issue with confirmation needing head wake",
        status: "in_progress",
        priority: "high",
        responsibleAgentId: admAgentId,
        assigneeAgentId: engAgentId,
      });

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: engAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
      });

      const svc = issueThreadInteractionService(db);
      const input = {
        kind: "request_confirmation" as const,
        idempotencyKey: `test:wakeup:confirmation:${issueId}`,
        sourceRunId: runId,
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          prompt: "Approve migration plan?",
        },
      };

      const interaction = await svc.create(
        { id: issueId, companyId },
        input,
        { agentId: engAgentId },
      );

      expect(interaction.addresseeAgentId).toBe(admAgentId);

      const heartbeat = heartbeatService(db);
      const wakeResult = await heartbeat.wakeup(interaction.addresseeAgentId!, {
        source: "automation",
        triggerDetail: "system",
        reason: "interaction_pending",
        payload: {
          issueId,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
        },
        idempotencyKey: `interaction-pending:${interaction.id}`,
        requestedByActorType: "agent",
        requestedByActorId: engAgentId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          wakeReason: "interaction_pending",
        },
      });

      expect(wakeResult).not.toBeNull();
      expect(wakeResult?.status).toBe("queued");
      const headRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, admAgentId),
            eq(heartbeatRuns.status, "queued"),
          ),
        );
      const targetRun = headRuns.find(
        (r) => (r.contextSnapshot as any)?.interactionId === interaction.id,
      );
      expect(targetRun).toBeDefined();
      expect(targetRun?.responsibleUserId).toBe(ownerUserId);
      expect((targetRun?.contextSnapshot as any)?.wakeReason).toBe("interaction_pending");
    });

    it("queued dispatch: defers wake when head is busy and does not fail with 422 responsible_user_unresolved", async () => {
      const issueId = randomUUID();
      const goalId = randomUUID();
      const runId = randomUUID();
      const headActiveRunId = randomUUID();

      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Deferred wake goal",
        level: "task",
        status: "active",
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        goalId,
        title: "Task with busy head agent",
        status: "in_progress",
        priority: "medium",
        responsibleAgentId: admAgentId,
        assigneeAgentId: engAgentId,
      });

      // Subordinate run
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: engAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
      });

      // Head agent is currently busy running on another task
      await db.insert(heartbeatRuns).values({
        id: headActiveRunId,
        companyId,
        agentId: admAgentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
      });

      const svc = issueThreadInteractionService(db);
      const input = {
        kind: "ask_user_questions" as const,
        idempotencyKey: `test:wakeup:deferred-busy:${issueId}`,
        sourceRunId: runId,
        continuationPolicy: "wake_assignee" as const,
        payload: {
          version: 1 as const,
          questions: [
            {
              id: "q_deferred",
              prompt: "Queued question while head is busy",
              selectionMode: "single" as const,
              options: [{ id: "ok", label: "OK" }],
            },
          ],
        },
      };

      const interaction = await svc.create(
        { id: issueId, companyId },
        input,
        { agentId: engAgentId },
      );
      expect(interaction.addresseeAgentId).toBe(admAgentId);

      const heartbeat = heartbeatService(db);
      // Waking the busy head agent must not throw 422 responsible_user_unresolved
      const wakeResult = await heartbeat.wakeup(interaction.addresseeAgentId!, {
        source: "automation",
        triggerDetail: "system",
        reason: "interaction_pending",
        payload: {
          issueId,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
        },
        idempotencyKey: `interaction-pending:${interaction.id}`,
        requestedByActorType: "agent",
        requestedByActorId: engAgentId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          wakeReason: "interaction_pending",
          source: "issue.interaction.created",
        },
      });

      // Wake is deferred behind active execution
      expect(wakeResult).toBeNull();

      // Verify wakeup request was parked in agentWakeupRequests and not lost
      const wakeRequests = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, admAgentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        );
      const targetRequest = wakeRequests.find(
        (r) => (r.payload as any)?.interactionId === interaction.id,
      );
      expect(targetRequest).toBeDefined();
      expect(targetRequest?.reason).toBe("interaction_pending");
      expect((targetRequest?.payload as any)?.issueId).toBe(issueId);
    });

    it("resolves default responsible user from companies.defaultResponsibleUserId when configured", async () => {
      const fallbackCompanyId = randomUUID();
      const fallbackOwnerUserId = randomUUID();
      const fallbackAdmId = randomUUID();
      const fallbackEngId = randomUUID();
      const fallbackIssueId = randomUUID();

      await db.insert(companies).values({
        id: fallbackCompanyId,
        name: "Fallback Co",
        issuePrefix: "FBC",
        defaultResponsibleUserId: fallbackOwnerUserId,
        requireBoardApprovalForNewAgents: false,
      });

      await db.insert(agents).values([
        {
          id: fallbackAdmId,
          companyId: fallbackCompanyId,
          name: "adm-fallback",
          role: "lead",
          status: "active",
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: fallbackEngId,
          companyId: fallbackCompanyId,
          name: "eng-fallback",
          role: "engineer",
          status: "active",
          reportsTo: fallbackAdmId,
          adapterType: "process",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);

      await db.insert(issues).values({
        id: fallbackIssueId,
        companyId: fallbackCompanyId,
        title: "Task with default responsible user on company",
        status: "in_progress",
        priority: "medium",
        responsibleAgentId: fallbackAdmId,
        assigneeAgentId: fallbackEngId,
      });

      const svc = issueThreadInteractionService(db);
      const interaction = await svc.create(
        { id: fallbackIssueId, companyId: fallbackCompanyId },
        {
          kind: "ask_user_questions" as const,
          idempotencyKey: `test:wakeup:fallback-company:${fallbackIssueId}`,
          continuationPolicy: "wake_assignee" as const,
          payload: {
            version: 1 as const,
            questions: [{ id: "q_fbc", prompt: "FBC?", selectionMode: "single" as const, options: [{ id: "ok", label: "OK" }] }],
          },
        },
        { agentId: fallbackEngId },
      );

      expect(interaction.addresseeAgentId).toBe(fallbackAdmId);

      const heartbeat = heartbeatService(db);
      const wakeResult = await heartbeat.wakeup(interaction.addresseeAgentId!, {
        source: "automation",
        triggerDetail: "system",
        reason: "interaction_pending",
        payload: {
          issueId: fallbackIssueId,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
        },
        idempotencyKey: `interaction-pending:${interaction.id}`,
        contextSnapshot: {
          issueId: fallbackIssueId,
          taskId: fallbackIssueId,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          wakeReason: "interaction_pending",
        },
      });

      expect(wakeResult).not.toBeNull();
      expect(wakeResult?.status).toBe("queued");
      const queuedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, fallbackAdmId),
            eq(heartbeatRuns.status, "queued"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      expect(queuedRun).toBeDefined();
      expect(queuedRun?.responsibleUserId).toBe(fallbackOwnerUserId);
      expect((queuedRun?.contextSnapshot as any)?.wakeReason).toBe("interaction_pending");
    });

    it("does not wake head agent when interaction has null addressee (paused head)", async () => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Task with paused head no-wake",
        status: "in_progress",
        priority: "medium",
        responsibleAgentId: pausedAgentId,
        assigneeAgentId: engAgentId,
      });

      const svc = issueThreadInteractionService(db);
      const interaction = await svc.create(
        { id: issueId, companyId },
        {
          kind: "ask_user_questions" as const,
          idempotencyKey: `test:wakeup:paused-no-wake:${issueId}`,
          continuationPolicy: "wake_assignee" as const,
          payload: {
            version: 1 as const,
            questions: [{ id: "q_paused", prompt: "Paused?", selectionMode: "single" as const, options: [{ id: "ok", label: "OK" }] }],
          },
        },
        { agentId: engAgentId },
      );

      // addresseeAgentId is null because head is paused
      expect(interaction.addresseeAgentId).toBeNull();

      // No wake dispatched: no run created for pausedAgentId
      const pausedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, pausedAgentId));
      expect(pausedRuns).toHaveLength(0);
    });
  });
});
