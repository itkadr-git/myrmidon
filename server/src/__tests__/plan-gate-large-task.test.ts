import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "@myrmidon/db";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issueThreadInteractions,
  issues,
  labels,
} from "@myrmidon/db";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { hasLargeSizeLabel, isLargeEngineeringTask } from "../myrmidon/plan-gate/large-task.js";
import {
  buildPaperclipTaskMarkdown,
  buildReviewerInputFromTaskData,
  heartbeatService,
} from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

type HeartbeatServiceInstance = ReturnType<typeof heartbeatService>;
type IssueServiceInstance = ReturnType<typeof issueService>;
type InteractionServiceInstance = ReturnType<typeof issueThreadInteractionService>;

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Plan gate test run.",
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

describe("plan-gate large task detection and directives", () => {
  it("detects size:M and size:L labels", () => {
    expect(hasLargeSizeLabel(["bug", "size:m"])).toBe(true);
    expect(hasLargeSizeLabel(["feature", "SIZE:L"])).toBe(true);
    expect(hasLargeSizeLabel(["size:s", "size:xs"])).toBe(false);
    expect(hasLargeSizeLabel([])).toBe(false);
  });

  it("identifies large engineering task for engineering agents", () => {
    expect(
      isLargeEngineeringTask({
        labels: ["size:M"],
        assigneeAgentRole: "engineer",
      }),
    ).toBe(true);

    expect(
      isLargeEngineeringTask({
        labels: ["size:S"],
        assigneeAgentRole: "engineer",
      }),
    ).toBe(false);

    expect(
      isLargeEngineeringTask({
        labels: ["size:L"],
        assigneeAgentRole: "pm",
      }),
    ).toBe(false);
  });

  it("includes 'Make the plan only' directive in planning mode", () => {
    const prompt = buildPaperclipTaskMarkdown({
      issue: {
        id: "task-1",
        identifier: "OPE-100",
        title: "Large Task",
        workMode: "planning",
        description: "Task description",
      },
    });

    expect(prompt).toContain("- Work mode: \"planning\"");
    expect(prompt).toContain("Make the plan only. Do not write code or perform implementation work.");
  });

  it("instructs reviewer to verify plan invariants when taskPlan is present", () => {
    const issue = {
      id: "issue-1",
      identifier: "OPE-100",
      title: "Task Title",
      description: "Description",
    };
    const pullRequest = {
      number: 123,
      repository: "itkadr-git/myrmidon",
      baseBranch: "main",
      headBranch: "bot/OPE-100",
      headSha: "abc1234",
    };
    const reviewerInput = buildReviewerInputFromTaskData({ issue, pullRequest });
    const prompt = buildPaperclipTaskMarkdown({
      issue: { ...issue, status: "in_review", workMode: "standard" },
      reviewerInput,
      taskPlan: {
        documentId: "doc-1",
        revisionId: "rev-1",
        revisionNumber: 1,
        body: "### Invariants\n1. Invariant check\n2. Safety check",
      },
    });

    expect(prompt).toContain("Plan invariants verification:");
    expect(prompt).toContain("Verify that the implementation satisfies the invariants specified in the task plan document.");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("plan-gate large task runtime behavior (issueService & heartbeatService)", () => {
  let db!: Db;
  let heartbeat!: HeartbeatServiceInstance;
  let issuesSvc!: IssueServiceInstance;
  let interactionsSvc!: InteractionServiceInstance;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-gate-test-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    issuesSvc = issueService(db);
    interactionsSvc = issueThreadInteractionService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const defaultUserId = "user-plan-gate";
    await db.insert(companies).values({
      id: companyId,
      name: "plan-gate-company",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: defaultUserId,
      requireBoardApprovalForNewAgents: false,
    });

    const engineerAgentId = randomUUID();
    await db.insert(agents).values({
      id: engineerAgentId,
      companyId,
      name: "engineer-agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });

    const pmAgentId = randomUUID();
    await db.insert(agents).values({
      id: pmAgentId,
      companyId,
      name: "pm-agent",
      role: "pm",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });

    const [labelM] = await db
      .insert(labels)
      .values({ companyId, name: "size:M", color: "#ffa500" })
      .returning();
    const [labelL] = await db
      .insert(labels)
      .values({ companyId, name: "size:L", color: "#ff4500" })
      .returning();
    const [labelS] = await db
      .insert(labels)
      .values({ companyId, name: "size:S", color: "#00ff00" })
      .returning();

    return {
      companyId,
      defaultUserId,
      engineerAgentId,
      pmAgentId,
      labelM: labelM!,
      labelL: labelL!,
      labelS: labelS!,
    };
  }

  describe("issueService.create plan gate", () => {
    it("enters workMode 'planning' when created with size:M or size:L for an engineer", async () => {
      const { companyId, engineerAgentId, labelM, labelL } = await seedFixture();

      const issueM = await issuesSvc.create(companyId, {
        title: "Large Task M",
        assigneeAgentId: engineerAgentId,
        labelIds: [labelM.id],
      });
      expect(issueM.workMode).toBe("planning");

      const issueL = await issuesSvc.create(companyId, {
        title: "Large Task L",
        assigneeAgentId: engineerAgentId,
        labelIds: [labelL.id],
      });
      expect(issueL.workMode).toBe("planning");
    });

    it("stays in workMode 'standard' for small tasks (size:S) or non-engineer roles", async () => {
      const { companyId, engineerAgentId, pmAgentId, labelS, labelM } = await seedFixture();

      const smallIssue = await issuesSvc.create(companyId, {
        title: "Small Task S",
        assigneeAgentId: engineerAgentId,
        labelIds: [labelS.id],
      });
      expect(smallIssue.workMode).toBe("standard");

      const pmIssue = await issuesSvc.create(companyId, {
        title: "PM Large Task M",
        assigneeAgentId: pmAgentId,
        labelIds: [labelM.id],
      });
      expect(pmIssue.workMode).toBe("standard");
    });

    it("stays in workMode 'standard' when initialPlan is already provided", async () => {
      const { companyId, engineerAgentId, labelM } = await seedFixture();

      const issueWithPlan = await issuesSvc.create(companyId, {
        title: "Large Task with Plan",
        assigneeAgentId: engineerAgentId,
        labelIds: [labelM.id],
        initialPlan: "### Plan\n1. Do steps",
      });
      expect(issueWithPlan.workMode).toBe("standard");
    });
  });

  describe("issueService.update plan gate & protected status boundary", () => {
    it("transitions backlog/todo issue to 'planning' when size:L label is added and no plan exists", async () => {
      const { companyId, engineerAgentId, labelL } = await seedFixture();

      const issue = await issuesSvc.create(companyId, {
        title: "Unsized Task",
        status: "todo",
        assigneeAgentId: engineerAgentId,
      });
      expect(issue.workMode).toBe("standard");

      const updated = await issuesSvc.update(issue.id, {
        labelIds: [labelL.id],
      });
      expect(updated.workMode).toBe("planning");
    });

    it("does not transition to 'planning' if a plan document already exists", async () => {
      const { companyId, engineerAgentId, labelL } = await seedFixture();

      const issue = await issuesSvc.create(companyId, {
        title: "Task with Plan Doc",
        status: "todo",
        assigneeAgentId: engineerAgentId,
      });
      const [doc] = await db
        .insert(documents)
        .values({
          companyId,
          title: "Existing Plan",
          format: "markdown",
          latestBody: "# Plan",
        })
        .returning();
      await db.insert(issueDocuments).values({
        companyId,
        issueId: issue.id,
        documentId: doc.id,
        key: "plan",
      });

      const updated = await issuesSvc.update(issue.id, {
        labelIds: [labelL.id],
      });
      expect(updated.workMode).toBe("standard");
    });

    it("protected status boundary: does NOT transition started (in_progress) or in_review tasks to planning", async () => {
      const { companyId, engineerAgentId, labelL } = await seedFixture();

      const startedIssue = await issuesSvc.create(companyId, {
        title: "Started Task",
        status: "in_progress",
        assigneeAgentId: engineerAgentId,
      });
      expect(startedIssue.workMode).toBe("standard");

      const updatedStarted = await issuesSvc.update(startedIssue.id, {
        labelIds: [labelL.id],
      });
      expect(updatedStarted.workMode).toBe("standard");

      const inReviewIssue = await issuesSvc.create(companyId, {
        title: "In Review Task",
        status: "in_review",
        assigneeAgentId: engineerAgentId,
      });
      expect(inReviewIssue.workMode).toBe("standard");

      const updatedInReview = await issuesSvc.update(inReviewIssue.id, {
        labelIds: [labelL.id],
      });
      expect(updatedInReview.workMode).toBe("standard");
    });
  });

  describe("heartbeatService plan approval pending denial & release after approval", () => {
    it("denies continuation wakes while plan confirmation is pending, releasing when approved", async () => {
      const { companyId, defaultUserId, engineerAgentId, labelM } = await seedFixture();

      const issue = await issuesSvc.create(companyId, {
        title: "Large Task Planning Continuation",
        status: "todo",
        assigneeAgentId: engineerAgentId,
        labelIds: [labelM.id],
      });
      expect(issue.workMode).toBe("planning");

      // Attach plan doc and create pending plan approval confirmation
      const rev1Id = randomUUID();
      const [doc1] = await db
        .insert(documents)
        .values({
          companyId,
          title: "Plan for Task",
          format: "markdown",
          latestBody: "# Plan",
          latestRevisionId: rev1Id,
        })
        .returning();
      await db.insert(issueDocuments).values({
        companyId,
        issueId: issue.id,
        documentId: doc1.id,
        key: "plan",
      });
      await db.insert(documentRevisions).values({
        id: rev1Id,
        companyId,
        documentId: doc1.id,
        revisionNumber: 1,
        title: "Plan for Task",
        format: "markdown",
        body: "# Plan",
      });

      const interaction = await interactionsSvc.create(
        { id: issue.id, companyId },
        {
          kind: "request_confirmation",
          continuationPolicy: "wake_assignee_on_accept",
          payload: {
            version: 1,
            prompt: "Accept plan?",
            target: {
              type: "issue_document",
              issueId: issue.id,
              documentId: doc1.id,
              key: "plan",
              revisionId: rev1Id,
              revisionNumber: 1,
            },
          },
        },
        { agentId: engineerAgentId },
      );
      expect(interaction.status).toBe("pending");

      // 1. Continuation wake is skipped while plan confirmation is pending
      const deniedWake = await heartbeat.enqueueWakeup(engineerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        payload: { issueId: issue.id },
      });
      expect(deniedWake).toBeNull();

      const wakeRequests = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, engineerAgentId),
            eq(agentWakeupRequests.reason, "plan_approval_pending"),
          ),
        );
      expect(wakeRequests).toHaveLength(1);
      expect(wakeRequests[0]?.status).toBe("skipped");

      const runsBeforeApproval = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, engineerAgentId));
      expect(runsBeforeApproval).toHaveLength(0);

      // 2. Accept plan confirmation interaction
      const accepted = await interactionsSvc.acceptInteraction(
        { id: issue.id, companyId, goalId: null, projectId: null },
        interaction.id,
        {},
        { userId: defaultUserId },
      );
      expect(accepted.interaction.status).toBe("accepted");

      const [reloadedIssue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issue.id));
      expect(reloadedIssue?.workMode).toBe("standard");

      // 3. Continuation wake is admitted after approval
      // An automatic continuation also needs new actor-visible input; the
      // approval is that input, passed as the continuation event id.
      const admittedWake = await heartbeat.enqueueWakeup(engineerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        payload: { issueId: issue.id, continuationEventId: `plan-approved:${interaction.id}` },
      });
      expect(admittedWake).not.toBeNull();
      expect(admittedWake?.status).not.toBe("skipped");
    });

    it("cancels queued runs with 'plan_approval_pending' while plan confirmation is pending", async () => {
      const { companyId, engineerAgentId, labelL } = await seedFixture();

      const issue = await issuesSvc.create(companyId, {
        title: "Queued Run Planning Task",
        status: "todo",
        assigneeAgentId: engineerAgentId,
        labelIds: [labelL.id],
      });
      expect(issue.workMode).toBe("planning");

      const rev2Id = randomUUID();
      const [doc2] = await db
        .insert(documents)
        .values({
          companyId,
          title: "Plan for Task",
          format: "markdown",
          latestBody: "# Plan",
          latestRevisionId: rev2Id,
        })
        .returning();
      await db.insert(issueDocuments).values({
        companyId,
        issueId: issue.id,
        documentId: doc2.id,
        key: "plan",
      });
      await db.insert(documentRevisions).values({
        id: rev2Id,
        companyId,
        documentId: doc2.id,
        revisionNumber: 1,
        title: "Plan for Task",
        format: "markdown",
        body: "# Plan",
      });

      // Pending plan confirmation
      await interactionsSvc.create(
        { id: issue.id, companyId },
        {
          kind: "request_confirmation",
          continuationPolicy: "wake_assignee_on_accept",
          payload: {
            version: 1,
            prompt: "Accept plan?",
            target: {
              type: "issue_document",
              issueId: issue.id,
              documentId: doc2.id,
              key: "plan",
              revisionId: rev2Id,
              revisionNumber: 1,
            },
          },
        },
        { agentId: engineerAgentId },
      );

      // Directly insert a queued run for this issue
      const [queuedRun] = await db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId: engineerAgentId,
          status: "queued",
          invocationSource: "automation",
          triggerDetail: "system",
          contextIssueId: issue.id,
          contextSnapshot: { issueId: issue.id },
        })
        .returning();

      expect(queuedRun).toBeDefined();

      // Dispatch queued runs: claimQueuedRun detects pending plan approval and cancels the run
      await heartbeat.sweepQueuedRunsWithoutRunning();

      const [checkedRun] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRun!.id));

      expect(checkedRun?.status).toBe("cancelled");
      expect(checkedRun?.errorCode).toBe("plan_approval_pending");
    });
  });

  describe("plan gate cannot be bypassed by wake type", () => {
    async function seedPlanningIssueWithPendingCard() {
      const { companyId, engineerAgentId, labelM } = await seedFixture();
      const issue = await issuesSvc.create(companyId, {
        title: "Planning Bypass Task",
        status: "todo",
        assigneeAgentId: engineerAgentId,
        labelIds: [labelM.id],
      });
      expect(issue.workMode).toBe("planning");

      const revId = randomUUID();
      const [doc] = await db
        .insert(documents)
        .values({
          companyId,
          title: "Plan for Task",
          format: "markdown",
          latestBody: "# Plan",
          latestRevisionId: revId,
        })
        .returning();
      await db.insert(issueDocuments).values({
        companyId,
        issueId: issue.id,
        documentId: doc!.id,
        key: "plan",
      });
      await db.insert(documentRevisions).values({
        id: revId,
        companyId,
        documentId: doc!.id,
        revisionNumber: 1,
        title: "Plan for Task",
        format: "markdown",
        body: "# Plan",
      });
      const payload = {
        version: 1 as const,
        prompt: "Accept plan?",
        target: {
          type: "issue_document" as const,
          issueId: issue.id,
          documentId: doc!.id,
          key: "plan",
          revisionId: revId,
          revisionNumber: 1,
        },
      };
      const insertCard = async (status: "pending" | "rejected") => {
        const [row] = await db
          .insert(issueThreadInteractions)
          .values({
            companyId,
            issueId: issue.id,
            kind: "request_confirmation",
            status,
            continuationPolicy: "wake_assignee_on_accept",
            createdByAgentId: engineerAgentId,
            payload,
            resolvedAt: status === "pending" ? null : new Date(),
          })
          .returning();
        return row!;
      };
      return { companyId, engineerAgentId, issue, insertCard };
    }

    async function queueRun(input: {
      companyId: string;
      agentId: string;
      issueId: string;
      context: Record<string, unknown>;
    }) {
      const [run] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          status: "queued",
          invocationSource: "automation",
          triggerDetail: "system",
          contextIssueId: input.issueId,
          contextSnapshot: { issueId: input.issueId, ...input.context },
        })
        .returning();
      await heartbeat.sweepQueuedRunsWithoutRunning();
      const [checked] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      return checked!;
    }

    it("cancels a wake-comment run while plan approval is pending", async () => {
      const { companyId, engineerAgentId, issue, insertCard } = await seedPlanningIssueWithPendingCard();
      await insertCard("pending");

      const checked = await queueRun({
        companyId,
        agentId: engineerAgentId,
        issueId: issue.id,
        context: { wakeCommentId: randomUUID(), wakeReason: "issue_commented" },
      });

      expect(checked.status).toBe("cancelled");
      expect(checked.errorCode).toBe("plan_approval_pending");
    });

    it("cancels an interaction-context run that is not the plan approval resolution", async () => {
      const { companyId, engineerAgentId, issue, insertCard } = await seedPlanningIssueWithPendingCard();
      const pending = await insertCard("pending");

      const checked = await queueRun({
        companyId,
        agentId: engineerAgentId,
        issueId: issue.id,
        context: {
          interactionId: pending.id,
          interactionKind: "request_confirmation",
          interactionStatus: "pending",
        },
      });

      expect(checked.status).toBe("cancelled");
      expect(checked.errorCode).toBe("plan_approval_pending");
    });

    it("skips an interaction continuation wake while plan approval is pending", async () => {
      const { engineerAgentId, issue, insertCard } = await seedPlanningIssueWithPendingCard();
      const pending = await insertCard("pending");

      const wake = await heartbeat.enqueueWakeup(engineerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        payload: { issueId: issue.id, interactionId: pending.id },
      });
      expect(wake).toBeNull();

      const receipts = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, engineerAgentId),
            eq(agentWakeupRequests.reason, "plan_approval_pending"),
          ),
        );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.status).toBe("skipped");
    });

    it("lets the resolved plan approval card wake through the gate", async () => {
      const { companyId, engineerAgentId, issue, insertCard } = await seedPlanningIssueWithPendingCard();
      const resolved = await insertCard("rejected");
      await insertCard("pending");

      const checked = await queueRun({
        companyId,
        agentId: engineerAgentId,
        issueId: issue.id,
        context: {
          interactionId: resolved.id,
          interactionKind: "request_confirmation",
          interactionStatus: "rejected",
        },
      });

      expect(checked.errorCode).not.toBe("plan_approval_pending");
      expect(checked.status).not.toBe("cancelled");
    });
  });
});
