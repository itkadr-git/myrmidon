import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("resp-head-int-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    admAgentId = randomUUID();
    leadAgentId = randomUUID();
    engAgentId = randomUUID();
    pausedAgentId = randomUUID();
    projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Resp Head Co",
      issuePrefix: "RHC",
      requireBoardApprovalForNewAgents: false,
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
});
