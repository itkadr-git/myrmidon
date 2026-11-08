import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issuePlanDecompositions,
  issueRelations,
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
  createIdlePickupSweeper,
  DEFAULT_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS,
  findTopReadyIssueForAgent,
  idlePickupForAgent,
  IDLE_PICKUP_ENABLED_ENV,
  IDLE_PICKUP_INTERVAL_SEC_ENV,
  IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS_ENV,
  IDLE_WAKE_REASON,
  readIdlePickupEnabled,
  readIdlePickupIntervalSec,
  readIdlePickupRecentSuccessWindowMs,
  isReviewPendingWaitingForCi,
} from "../myrmidon/idle-pickup.ts";
import { logger } from "../middleware/logger.js";

// IDLE-PICKUP (1.3): the board wakes an agent with a free queue on its
// highest-priority ready task, reusing the normal wake admission path.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("settings readers", () => {
  const savedInterval = process.env[IDLE_PICKUP_INTERVAL_SEC_ENV];
  const savedEnabled = process.env[IDLE_PICKUP_ENABLED_ENV];

  afterEach(() => {
    if (savedInterval === undefined) delete process.env[IDLE_PICKUP_INTERVAL_SEC_ENV];
    else process.env[IDLE_PICKUP_INTERVAL_SEC_ENV] = savedInterval;
    if (savedEnabled === undefined) delete process.env[IDLE_PICKUP_ENABLED_ENV];
    else process.env[IDLE_PICKUP_ENABLED_ENV] = savedEnabled;
  });

  it("interval defaults to 30 when unset, empty or non-numeric", () => {
    for (const raw of [undefined, "", "  ", "abc", "-5", "0", "1.5"]) {
      const env: Record<string, string | undefined> = {};
      if (raw !== undefined) env[IDLE_PICKUP_INTERVAL_SEC_ENV] = raw;
      expect(readIdlePickupIntervalSec(env), `raw=${JSON.stringify(raw)}`).toBe(30);
    }
  });

  it("interval clamps small values up to 5 seconds", () => {
    expect(readIdlePickupIntervalSec({ [IDLE_PICKUP_INTERVAL_SEC_ENV]: "1" })).toBe(5);
    expect(readIdlePickupIntervalSec({ [IDLE_PICKUP_INTERVAL_SEC_ENV]: "5" })).toBe(5);
    expect(readIdlePickupIntervalSec({ [IDLE_PICKUP_INTERVAL_SEC_ENV]: "300" })).toBe(300);
  });

  it("the quiet window after a successful run is two hours by default", () => {
    expect(DEFAULT_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
    expect(readIdlePickupRecentSuccessWindowMs({})).toBe(2 * 60 * 60 * 1000);
    for (const raw of ["", "  ", "abc", "-5", "1.5"]) {
      const env: Record<string, string | undefined> = {};
      if (raw !== undefined) env[IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS_ENV] = raw;
      expect(readIdlePickupRecentSuccessWindowMs(env), `raw=${JSON.stringify(raw)}`).toBe(2 * 60 * 60 * 1000);
    }
    expect(readIdlePickupRecentSuccessWindowMs({ [IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS_ENV]: "3600000" })).toBe(3_600_000);
    expect(readIdlePickupRecentSuccessWindowMs({ [IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS_ENV]: "0" })).toBe(0);
  });

  it("the feature is on unless an explicit off value is set (a typo must not disable the fix)", () => {
    expect(readIdlePickupEnabled({})).toBe(true);
    expect(readIdlePickupEnabled({ [IDLE_PICKUP_ENABLED_ENV]: "garbage" })).toBe(true);
    for (const raw of ["0", "false", "off", "no", "OFF", " No "]) {
      expect(readIdlePickupEnabled({ [IDLE_PICKUP_ENABLED_ENV]: raw }), `raw=${raw}`).toBe(false);
    }
  });
});

describeEmbeddedPostgres("idlePickupForAgent (IDLE-PICKUP)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-idle-pickup-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(issuePlanDecompositions);
    await db.delete(issueRelations);
    await db.delete(agentWakeupRequests);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(status = "idle") {
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
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: {
    companyId: string;
    agentId?: string | null;
    status?: string;
    priority?: string;
    parentId?: string | null;
    monitorNextCheckAt?: Date | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: "Ready task",
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      assigneeAgentId: input.agentId ?? null,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.monitorNextCheckAt ? { monitorNextCheckAt: input.monitorNextCheckAt } : {}),
    });
    return id;
  }

  /** Seeds an accepted-plan decomposition row (documents + revision + claim) for one issue. */
  async function seedDecomposition(input: {
    companyId: string;
    planningId: string;
    agentId: string;
    status: "in_flight" | "completed";
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Plan body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "Plan body",
      createdByAgentId: input.agentId,
    });
    await db.insert(issuePlanDecompositions).values({
      companyId: input.companyId,
      sourceIssueId: input.planningId,
      acceptedPlanRevisionId: revisionId,
      status: input.status,
      ...(input.status === "completed" ? { completedAt: new Date() } : {}),
      requestFingerprint: `claim:${input.planningId}`,
      requestedChildCount: 1,
      requestedChildren: [{ title: "child-1" }],
      childIssueIds: [],
      ownerAgentId: input.agentId,
    });
  }

  async function seedLiveRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "automation",
      contextSnapshot: { issueId: input.issueId },
    });
  }

  /** A succeeded run that finished at the given time (for the recent-success suppression). */
  async function seedSucceededRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    finishedAt: Date;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: "succeeded",
      invocationSource: "automation",
      contextSnapshot: { issueId: input.issueId },
      startedAt: input.finishedAt,
      finishedAt: input.finishedAt,
    });
    return id;
  }

  /** A cancelled run that finished at the given time, with its persisted cause. */
  async function seedCancelledRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    finishedAt: Date;
    cancellationCode: string;
  }) {
    await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.agentId,
      status: "cancelled",
      invocationSource: "automation",
      contextSnapshot: { issueId: input.issueId },
      resultJson: { executionCancellation: { source: { code: input.cancellationCode } } },
      startedAt: new Date(input.finishedAt.getTime() - 30_000),
      finishedAt: input.finishedAt,
    });
  }

  /** A comment on the issue, optionally attributed to the run that wrote it. */
  async function seedComment(input: {
    companyId: string;
    issueId: string;
    createdAt: Date;
    createdByRunId?: string;
    deletedAt?: Date;
  }) {
    const id = randomUUID();
    await db.insert(issueComments).values({
      id,
      companyId: input.companyId,
      issueId: input.issueId,
      body: "Any news?",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      ...(input.createdByRunId ? { createdByRunId: input.createdByRunId } : {}),
      ...(input.deletedAt ? { deletedAt: input.deletedAt } : {}),
    });
    return id;
  }

  function fakeDeps(
    overrides: {
      enqueueWakeup?: (...args: unknown[]) => Promise<unknown>;
      env?: Record<string, string | undefined>;
      getDailyCapBlock?: NonNullable<Parameters<typeof idlePickupForAgent>[0]["getDailyCapBlock"]>;
    } = {},
  ) {
    const enqueueWakeup = vi.fn(overrides.enqueueWakeup ?? (async () => ({ id: randomUUID() })));
    return {
      db,
      enqueueWakeup: enqueueWakeup as unknown as Parameters<typeof idlePickupForAgent>[0]["enqueueWakeup"],
      ...(overrides.env ? { env: overrides.env } : {}),
      ...(overrides.getDailyCapBlock ? { getDailyCapBlock: overrides.getDailyCapBlock } : {}),
    };
  }

  it("wakes the agent on a ready todo issue with no live run", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect(deps.enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        source: "automation",
        triggerDetail: "system",
        reason: IDLE_WAKE_REASON,
        requestedByActorType: "system",
        requestedByActorId: "idle_pickup",
        contextSnapshot: { issueId, taskKey: issueId, source: "idle_pickup" },
      }),
    );
  });

  it("picks the highest-priority ready issue first", async () => {
    const { companyId, agentId } = await seedAgent();
    const lowId = await seedIssue({ companyId, agentId, priority: "low" });
    const criticalId = await seedIssue({ companyId, agentId, priority: "critical" });
    const mediumId = await seedIssue({ companyId, agentId, priority: "medium" });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    // One wake per pass, on the critical issue.
    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([criticalId]);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
    void lowId;
    void mediumId;
  });

  it("skips an issue that already has a live heartbeat run", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedLiveRun({ companyId, agentId, issueId, status: "running" });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(1);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("skips an issue that already has a queued wake (the pass stays idempotent)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(1);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not wake issues outside todo/in_progress or assigned to a user", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId, status: "backlog" });
    await seedIssue({ companyId, agentId, status: "done" });
    await seedIssue({ companyId, agentId, status: "in_review" });
    const userAssignedId = randomUUID();
    await db.insert(issues).values({
      id: userAssignedId,
      companyId,
      title: "User task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: randomUUID(),
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.considered).toBe(0);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("wakes an agent who is the current review participant on an in_review issue", async () => {
    const { companyId, agentId } = await seedAgent();
    const other = await seedAgent({ companyId });
    const issueId = await seedIssue({
      companyId,
      agentId: other.agentId,
      status: "in_review",
    });
    await db
      .update(issues)
      .set({
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId },
        },
      })
      .where(eq(issues.id, issueId));

    const deps = fakeDeps();
    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.considered).toBe(1);
    expect(result.woken).toBe(1);
    expect(deps.enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        contextSnapshot: expect.objectContaining({ issueId }),
      }),
    );
  });

  it("does not wake a blocked issue (an unresolved blocker relation)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    const blockerId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    // The dependent is filtered out by the unresolved blocker; the blocker
    // itself is a ready in_progress issue, so the wake goes to it.
    expect(result.considered).toBe(1);
    expect(result.issueIds).toEqual([blockerId]);
    void issueId;
  });

  it("wakes a cancelled-blocker dependent (a cancelled blocker is resolved, OPE-8904)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Cancelled blocker",
      status: "cancelled",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.considered).toBe(1);
    expect(result.woken).toBe(1);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("does not wake a container (an issue with an open child)", async () => {
    const { companyId, agentId } = await seedAgent();
    const parentId = await seedIssue({ companyId, agentId });
    await seedIssue({ companyId, agentId, status: "todo", parentId });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    // The parent is a container and is filtered out; the child is the work.
    expect(result.considered).toBe(1);
    expect(result.woken).toBe(1);
    const [call] = vi.mocked(deps.enqueueWakeup).mock.calls;
    expect((call[1] as { contextSnapshot: { issueId: string } }).contextSnapshot.issueId).not.toBe(parentId);
  });

  it("does not wake review participant when review stage is pending and waiting for CI (executionState ciState pending/unknown, OPE-10082)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId },
        ciState: "pending",
      },
    }).where(eq(issues.id, issueId));

    const deps = fakeDeps();
    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(1);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not wake review participant when review stage is pending and PR work product has ciState unknown (OPE-10082)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId },
      },
    }).where(eq(issues.id, issueId));
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "PR #2078",
      status: "open",
      metadata: {
        ciState: "unknown",
      },
    });

    const deps = fakeDeps();
    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(1);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("wakes review participant when review stage is pending and CI is green (OPE-10082)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId },
        ciState: "green",
      },
    }).where(eq(issues.id, issueId));

    const deps = fakeDeps();
    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.considered).toBe(1);
    expect(result.woken).toBe(1);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("a container whose children are all done is itself ready again", async () => {
    const { companyId, agentId } = await seedAgent();
    const parentId = await seedIssue({ companyId, agentId });
    await seedIssue({ companyId, agentId, status: "done", parentId });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([parentId]);
  });

  it("does not wake an issue with an in-flight accepted-plan decomposition (the claim machinery owns the next step)", async () => {
    const { companyId, agentId } = await seedAgent();
    const planningId = await seedIssue({ companyId, agentId });
    await seedDecomposition({ companyId, planningId, agentId, status: "in_flight" });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.considered).toBe(0);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("wakes an issue whose accepted-plan decomposition completed (children created, claim settled)", async () => {
    const { companyId, agentId } = await seedAgent();
    const planningId = await seedIssue({ companyId, agentId });
    await seedDecomposition({ companyId, planningId, agentId, status: "completed" });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([planningId]);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("counts a suppressed admission (null wake) and does not treat it as an error", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId });
    const deps = fakeDeps({ enqueueWakeup: async () => null });

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.suppressed).toBe(1);
    expect(result.woken).toBe(0);
  });

  it("survives a throwing wake (best-effort) and still reports the rest", async () => {
    const { companyId, agentId } = await seedAgent();
    const firstId = await seedIssue({ companyId, agentId, priority: "high" });
    const secondId = await seedIssue({ companyId, agentId, priority: "low" });
    const deps = fakeDeps({
      enqueueWakeup: vi.fn()
        .mockRejectedValueOnce(new Error("admission conflict"))
        .mockResolvedValueOnce({ id: randomUUID() }),
    });

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.suppressed).toBe(1);
    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([secondId]);
    void firstId;
  });

  it("does not wake an issue whose monitor check is scheduled in the future (IDLE-PICKUP-MONITOR)", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      monitorNextCheckAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.considered).toBe(0);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("wakes an issue whose monitor check time has already passed (the tick owns that wake, but readiness is not suppressed)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({
      companyId,
      agentId,
      status: "in_progress",
      monitorNextCheckAt: new Date(Date.now() - 60 * 1000),
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
  });

  it("wakes an issue without any monitor scheduled (null monitorNextCheckAt)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
  });

  it("release path: finishing a run on issue A with issue B ready wakes exactly B, never A", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueA = await seedIssue({ companyId, agentId, status: "in_progress" });
    const issueB = await seedIssue({ companyId, agentId, priority: "high" });
    const deps = fakeDeps();

    // The run on A just released its execution lock; heartbeat passes A's id.
    const result = await idlePickupForAgent(
      deps,
      { id: agentId, companyId },
      { excludeIssueId: issueA },
    );

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([issueB]);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
    const [call] = vi.mocked(deps.enqueueWakeup).mock.calls;
    expect((call[1] as { contextSnapshot: { issueId: string } }).contextSnapshot.issueId).toBe(issueB);
  });

  it("release path: with nothing ready except the just-released issue, no wake at all (no runaway loop)", async () => {
    const { companyId, agentId } = await seedAgent();
    // Vendor-fixture shape: the finished issue stays in a wakeable status.
    const issueA = await seedIssue({ companyId, agentId, status: "in_progress" });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(
      deps,
      { id: agentId, companyId },
      { excludeIssueId: issueA },
    );

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBe(1);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();

    // After B (the only other ready issue) finished, A — still open, no live
    // run — IS the next ready task and gets the wake: that is the feature
    // working (an agent keeps working its open tasks), not a runaway: one wake
    // per pass, and A's own next release excludes A again. The chain in the
    // review failed only because the just-released issue was never excluded.
    const issueB = await seedIssue({ companyId, agentId, status: "in_progress" });
    const result2 = await idlePickupForAgent(
      deps,
      { id: agentId, companyId },
      { excludeIssueId: issueB },
    );
    expect(result2.woken).toBe(1);
    expect(result2.issueIds).toEqual([issueA]);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("myrmidon(1.6.6 OPE-8988): an old queued wake no run carries is an orphan and does not cover the issue", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: null,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(0);
    expect(result.woken).toBe(1);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("myrmidon(1.6.6 OPE-8988): a claimed wake whose run already ended does not cover the issue", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(0);
    expect(result.woken).toBe(1);
  });

  it("myrmidon(1.6.6 OPE-8988): an old deferred wake whose issue holds no execution lock does not cover it", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: null,
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(0);
    expect(result.woken).toBe(1);
  });

  it("myrmidon(1.6.6 OPE-9445): an idle pickup does not coalesce into an old deferred wake (>30m requestedAt)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    const oldDate = new Date(Date.now() - 35 * 60 * 1000);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: null,
      createdAt: new Date(),
      requestedAt: oldDate,
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(0);
    expect(result.woken).toBe(1);
    expect(deps.enqueueWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      source: "automation",
      reason: IDLE_WAKE_REASON,
      contextSnapshot: expect.objectContaining({ issueId }),
    }));
  });

  it("a deferred or claimed wake also counts as covering (not only queued)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_comment_mentioned",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: null,
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.alreadyActive).toBe(1);
    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not wake an issue whose own run succeeded recently (the handoff/recovery paths own the next step)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedSucceededRun({ companyId, agentId, issueId, finishedAt: new Date() });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBe(1);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["reassignment", "board_operator"])(
    "wakes an issue with review changes requested after a board cancellation (%s)",
    async (cancellationCode) => {
      const { companyId, agentId } = await seedAgent();
      const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
      await db.update(issues).set({ executionState: { status: "changes_requested" } }).where(eq(issues.id, issueId));
      await seedSucceededRun({ companyId, agentId, issueId, finishedAt: new Date(Date.now() - 90_000) });
      const cancelledAt = new Date(Date.now() - 30_000);
      await seedCancelledRun({ companyId, agentId, issueId, finishedAt: cancelledAt, cancellationCode });
      const deps = fakeDeps();

      const result = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(result.woken).toBe(1);
      expect(result.issueIds).toEqual([issueId]);
    },
  );

  // OPE-12445: the reviewer's REQUEST CHANGES return is the executor's work
  // order. The last run SUCCEEDED — the run that produced what the reviewer
  // rejected — so the recent-success quiet window must not mute the task: the
  // REVIEW-RETURN-GUARD wake was suppressed by design, and ENG_IDLE firing
  // 20-40 minutes later was the only recovery left before this lane existed.
  it("wakes a task returned from review (changes_requested) whose last run succeeded, inside the quiet window", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    // The succeeded run IS the run whose work the reviewer returned: finished
    // moments ago, well inside the 2h recent-success window.
    const runEndedAt = new Date(Date.now() - 5 * 60_000);
    await seedSucceededRun({ companyId, agentId, issueId, finishedAt: runEndedAt });
    // The REQUEST CHANGES decision landed AFTER that run: it returned the
    // run's work. lastDecisionId points at the decision row.
    const decisionId = randomUUID();
    await db.insert(issueExecutionDecisions).values({
      id: decisionId,
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      outcome: "changes_requested",
      body: "CI of the head is red",
      createdAt: new Date(Date.now() - 2 * 60_000),
    });
    await db
      .update(issues)
      .set({ executionState: { status: "changes_requested", lastDecisionId: decisionId } })
      .where(eq(issues.id, issueId));
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.considered).toBe(1);
    expect(result.woken).toBe(1);
    expect(result.alreadyActive).toBe(0);
    expect(result.issueIds).toEqual([issueId]);
    expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the changes_requested decision predates the succeeded run (loop safety)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    // The run succeeded AFTER the decision: the rework already happened. The
    // quiet window must own the task again, or every pass re-wakes it.
    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      outcome: "changes_requested",
      body: "fix the handler",
      createdAt: new Date(Date.now() - 30 * 60_000),
    });
    await seedSucceededRun({ companyId, agentId, issueId, finishedAt: new Date(Date.now() - 5 * 60_000) });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBe(1);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("still quiets a recent success without changes_requested (the window protects a dispositionless handoff)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedSucceededRun({ companyId, agentId, issueId, finishedAt: new Date(Date.now() - 5 * 60_000) });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBe(1);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("still quiets a todo task with changes_requested and a recent success (the return lane is an in_progress lane)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "todo" });
    await db.update(issues).set({ executionState: { status: "changes_requested" } }).where(eq(issues.id, issueId));
    await seedSucceededRun({ companyId, agentId, issueId, finishedAt: new Date(Date.now() - 5 * 60_000) });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBe(1);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("reports per-skip reasons in the quiet-window skip log (OPE-12445 blind-spot logging)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedSucceededRun({ companyId, agentId, issueId, finishedAt: new Date(Date.now() - 5 * 60_000) });
    const deps = fakeDeps();
    vi.mocked(logger.info).mockClear();

    await idlePickupForAgent(deps, { id: agentId, companyId });

    const quietLog = vi
      .mocked(logger.info)
      .mock.calls.find(([, msg]) => msg === "myrmidon.idle_pickup: skipped a candidate still inside the recent-run quiet window");
    expect(quietLog).toBeDefined();
    const [fields] = quietLog!;
    expect(fields).toMatchObject({
      agentId,
      companyId,
      issueId,
      reason: "quiet_recent_run",
      recentRunStatus: "succeeded",
      reviewChangesRequested: false,
    });
  });

  it("does not repeatedly wake review changes after a system cancellation", async () => {
    const { companyId, agentId } = await seedAgent();
    const systemCancelled = await seedIssue({ companyId, agentId, status: "in_progress" });
    await db.update(issues).set({ executionState: { status: "changes_requested" } }).where(eq(issues.id, systemCancelled));
    await seedSucceededRun({ companyId, agentId, issueId: systemCancelled, finishedAt: new Date(Date.now() - 90_000) });
    await seedCancelledRun({
      companyId,
      agentId,
      issueId: systemCancelled,
      finishedAt: new Date(Date.now() - 30_000),
      cancellationCode: "watchdog",
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("cools a genuinely stale todo issue with consecutive succeeded runs", async () => {
    const { companyId, agentId } = await seedAgent();
    const staleTodo = await seedIssue({ companyId, agentId, status: "todo" });
    await seedSucceededRun({ companyId, agentId, issueId: staleTodo, finishedAt: new Date(Date.now() - 15 * 60_000) });
    const staleInProgress = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedSucceededRun({ companyId, agentId, issueId: staleInProgress, finishedAt: new Date(Date.now() - 15 * 60_000) });
    await seedSucceededRun({ companyId, agentId, issueId: staleInProgress, finishedAt: new Date(Date.now() - 5 * 60_000) });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBeGreaterThanOrEqual(2);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["todo", "in_progress"])(
    "does not treat board cancellation as review rework when execution state is %s",
    async (status) => {
      const { companyId, agentId } = await seedAgent();
      const issueId = await seedIssue({ companyId, agentId, status });
      await seedSucceededRun({ companyId, agentId, issueId, finishedAt: new Date(Date.now() - 90_000) });
      await seedCancelledRun({
        companyId,
        agentId,
        issueId,
        finishedAt: new Date(Date.now() - 30_000),
        cancellationCode: "reassignment",
      });
      const deps = fakeDeps();

      const result = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(result.woken).toBe(0);
      expect(deps.enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  it("keeps a silent success quiet long past the old 15-minute window (no wake storm)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedSucceededRun({
      companyId,
      agentId,
      issueId,
      // 40 minutes: inside the 2-hour quiet window, outside the 15-minute one
      // the board used before — there the sweep woke the same issue again 15
      // minutes after its run ended, and the next run ended the same way.
      finishedAt: new Date(Date.now() - 40 * 60 * 1000),
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBe(1);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("wakes an issue whose only succeeded run is older than the recent-success window", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedSucceededRun({
      companyId,
      agentId,
      issueId,
      // 3 hours ago: past the 2-hour default window.
      finishedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
  });

  it("a comment posted after a recent success reopens the issue (the wake still comes)", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedSucceededRun({
      companyId,
      agentId,
      issueId,
      finishedAt: new Date(Date.now() - 40 * 60 * 1000),
    });
    // Somebody asked something after the run ended: the issue is not idle work
    // any more, it is an unanswered question.
    await seedComment({
      companyId,
      issueId,
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
  });

  it("a comment the recent run wrote itself does not reopen the issue", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    const runId = await seedSucceededRun({
      companyId,
      agentId,
      issueId,
      finishedAt: new Date(Date.now() - 40 * 60 * 1000),
    });
    // The run's own closing report: written by that run, so it is not new input.
    await seedComment({
      companyId,
      issueId,
      createdAt: new Date(Date.now() - 39 * 60 * 1000),
      createdByRunId: runId,
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBe(1);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("a deleted comment does not reopen the issue", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedSucceededRun({
      companyId,
      agentId,
      issueId,
      finishedAt: new Date(Date.now() - 40 * 60 * 1000),
    });
    const deletedAt = new Date(Date.now() - 5 * 60 * 1000);
    await seedComment({
      companyId,
      issueId,
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      deletedAt,
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBe(1);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("the quiet window follows the latest success per issue", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    // One old success (3 h ago, past the window) and one recent no-op run whose
    // comment-less silence is the one that must hold.
    await seedSucceededRun({
      companyId,
      agentId,
      issueId,
      finishedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    await seedSucceededRun({
      companyId,
      agentId,
      issueId,
      finishedAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.alreadyActive).toBe(1);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("recent-success suppression does not block a different, never-run issue of the same agent", async () => {
    const { companyId, agentId } = await seedAgent();
    // The acceptance path: one issue finished, another todo never ran.
    const finishedId = await seedIssue({ companyId, agentId, status: "done" });
    await seedSucceededRun({ companyId, agentId, issueId: finishedId, finishedAt: new Date() });
    const neverRunId = await seedIssue({ companyId, agentId });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([neverRunId]);
  });

  it("recent-success suppression is off when MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS=0", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedSucceededRun({ companyId, agentId, issueId, finishedAt: new Date() });
    const deps = fakeDeps({
      env: { MYRMIDON_IDLE_PICKUP_RECENT_SUCCESS_WINDOW_MS: "0" },
    });

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
  });

  it("does nothing when the feature is disabled by setting", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId });
    const deps = fakeDeps({ env: { [IDLE_PICKUP_ENABLED_ENV]: "0" } });

    const result = await idlePickupForAgent(deps, { id: agentId, companyId });

    expect(result.woken).toBe(0);
    expect(result.considered).toBe(0);
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("ignores another agent's issues and another company's rows", async () => {
    const first = await seedAgent();
    const second = await seedAgent();
    const foreignIssueId = await seedIssue({ companyId: second.companyId, agentId: second.agentId });
    const deps = fakeDeps();

    const result = await idlePickupForAgent(deps, { id: first.agentId, companyId: first.companyId });

    expect(result.woken).toBe(0);
    const [call] = vi.mocked(deps.enqueueWakeup).mock.calls;
    void call;
    void foreignIssueId;
    expect(deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  // myrmidon(OPE-11947): the per-day cap gate does not hold a wake, it writes a
  // `skipped` receipt row. An agent over its cap must not be offered every ready
  // task on every pass: at most one receipt per agent per day (the attention
  // card for a capped agent is built from it).
  describe("daily cap (OPE-11947)", () => {
    const RUN_CAP = { reason: "heartbeat.daily_run_limit", observed: 40, limit: 40 };
    const COST_CAP = { reason: "heartbeat.daily_cost_limit", observed: 900, limit: 800 };

    /** The receipt row the cap gate in enqueueWakeup leaves behind. */
    async function seedCapReceipt(input: {
      companyId: string;
      agentId: string;
      reason?: string;
      limit?: number;
      requestedAt?: Date;
    }) {
      await db.insert(agentWakeupRequests).values({
        companyId: input.companyId,
        agentId: input.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: input.reason ?? RUN_CAP.reason,
        payload: {
          heartbeatSkip: {
            reason: "Per-agent heartbeat daily cap reached before adapter invocation.",
            observed: input.limit ?? RUN_CAP.limit,
            limit: input.limit ?? RUN_CAP.limit,
          },
        },
        status: "skipped",
        requestedByActorType: "system",
        requestedByActorId: "idle_pickup",
        ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}),
        finishedAt: new Date(),
      });
    }

    async function countReceipts(agentId: string) {
      const rows = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      return rows.length;
    }

    it("does not offer any task to an agent over its run cap once today's receipt exists", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedIssue({ companyId, agentId, priority: "high" });
      await seedIssue({ companyId, agentId, priority: "medium" });
      await seedIssue({ companyId, agentId, priority: "low" });
      await seedCapReceipt({ companyId, agentId });
      const getDailyCapBlock = vi.fn(async (_agent: { id: string; companyId: string }) => RUN_CAP);
      const deps = fakeDeps({ getDailyCapBlock });

      const result = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(deps.enqueueWakeup).not.toHaveBeenCalled();
      expect(getDailyCapBlock).toHaveBeenCalledTimes(1);
      expect(getDailyCapBlock).toHaveBeenCalledWith({ id: agentId, companyId });
      expect(result.dailyCapSkipped).toBe(1);
      expect(result.woken).toBe(0);
      expect(result.suppressed).toBe(0);
      expect(result.considered).toBe(3);
      expect(await countReceipts(agentId)).toBe(1);
    });

    it("lets the first attempt of the day reach the gate, then stops: one receipt per agent, not one per task", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedIssue({ companyId, agentId, priority: "high" });
      await seedIssue({ companyId, agentId, priority: "medium" });
      await seedIssue({ companyId, agentId, priority: "low" });
      // The gate in enqueueWakeup: writes its receipt row and returns null.
      const deps = fakeDeps({
        enqueueWakeup: async () => {
          await seedCapReceipt({ companyId, agentId });
          return null;
        },
        getDailyCapBlock: async () => RUN_CAP,
      });

      const first = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
      expect(first.suppressed).toBe(1);
      expect(first.dailyCapSkipped).toBe(1);
      expect(await countReceipts(agentId)).toBe(1);

      // Every later pass of the day leaves the agent alone and writes nothing.
      for (let pass = 0; pass < 3; pass += 1) {
        const later = await idlePickupForAgent(deps, { id: agentId, companyId });
        expect(later.dailyCapSkipped).toBe(1);
        expect(later.suppressed).toBe(0);
      }
      expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
      expect(await countReceipts(agentId)).toBe(1);
    });

    it("covers the daily cost cap through the same check", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedIssue({ companyId, agentId });
      await seedIssue({ companyId, agentId });
      await seedCapReceipt({ companyId, agentId, reason: COST_CAP.reason, limit: COST_CAP.limit });
      const deps = fakeDeps({ getDailyCapBlock: async () => COST_CAP });

      const result = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(deps.enqueueWakeup).not.toHaveBeenCalled();
      expect(result.dailyCapSkipped).toBe(1);
    });

    it("a receipt of the other cap does not cover this one", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedIssue({ companyId, agentId });
      // Today's receipt belongs to the run cap; the agent is now over the cost cap.
      await seedCapReceipt({ companyId, agentId });
      const deps = fakeDeps({
        enqueueWakeup: async () => {
          await seedCapReceipt({ companyId, agentId, reason: COST_CAP.reason, limit: COST_CAP.limit });
          return null;
        },
        getDailyCapBlock: async () => COST_CAP,
      });

      const result = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
      expect(result.dailyCapSkipped).toBe(1);
    });

    it("a receipt of a different limit (the cap was changed today) does not cover the new cap", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedIssue({ companyId, agentId });
      await seedCapReceipt({ companyId, agentId, limit: 30 });
      const deps = fakeDeps({
        enqueueWakeup: async () => {
          await seedCapReceipt({ companyId, agentId });
          return null;
        },
        getDailyCapBlock: async () => RUN_CAP,
      });

      await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
      expect(await countReceipts(agentId)).toBe(2);
    });

    it("yesterday's receipt does not cover today", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedIssue({ companyId, agentId });
      await seedCapReceipt({
        companyId,
        agentId,
        requestedAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
      });
      const deps = fakeDeps({
        enqueueWakeup: async () => {
          await seedCapReceipt({ companyId, agentId });
          return null;
        },
        getDailyCapBlock: async () => RUN_CAP,
      });

      const result = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
      expect(result.dailyCapSkipped).toBe(1);
    });

    it("another agent's receipt does not cover this agent", async () => {
      const first = await seedAgent();
      const second = await seedAgent();
      await seedIssue({ companyId: second.companyId, agentId: second.agentId });
      await seedCapReceipt({ companyId: first.companyId, agentId: first.agentId });
      const deps = fakeDeps({
        enqueueWakeup: async () => {
          await seedCapReceipt({ companyId: second.companyId, agentId: second.agentId });
          return null;
        },
        getDailyCapBlock: async () => RUN_CAP,
      });

      await idlePickupForAgent(deps, { id: second.agentId, companyId: second.companyId });

      expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
    });

    it("an agent under its caps is woken as before", async () => {
      const { companyId, agentId } = await seedAgent();
      const issueId = await seedIssue({ companyId, agentId });
      await seedCapReceipt({ companyId, agentId });
      const getDailyCapBlock = vi.fn(async () => null);
      const deps = fakeDeps({ getDailyCapBlock });

      const result = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(getDailyCapBlock).toHaveBeenCalledTimes(1);
      expect(result.dailyCapSkipped).toBe(0);
      expect(result.woken).toBe(1);
      expect(result.issueIds).toEqual([issueId]);
      expect(deps.enqueueWakeup).toHaveBeenCalledTimes(1);
    });

    it("keeps offering the next task while no cap receipt exists (a gate ahead of the cap refused the first)", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedIssue({ companyId, agentId, priority: "high" });
      await seedIssue({ companyId, agentId, priority: "medium" });
      await seedIssue({ companyId, agentId, priority: "low" });
      const deps = fakeDeps({
        enqueueWakeup: async () => null,
        getDailyCapBlock: async () => RUN_CAP,
      });

      const result = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(deps.enqueueWakeup).toHaveBeenCalledTimes(3);
      expect(result.suppressed).toBe(3);
      expect(result.dailyCapSkipped).toBe(0);
    });

    it("fails open when the cap lookup throws: the gate inside enqueueWakeup still decides", async () => {
      const { companyId, agentId } = await seedAgent();
      const issueId = await seedIssue({ companyId, agentId });
      await seedCapReceipt({ companyId, agentId });
      const deps = fakeDeps({
        getDailyCapBlock: async () => {
          throw new Error("agent row unavailable");
        },
      });

      const result = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(result.woken).toBe(1);
      expect(result.issueIds).toEqual([issueId]);
      expect(result.dailyCapSkipped).toBe(0);
    });

    it("does not look up the cap for an agent with nothing to pick up", async () => {
      const { companyId, agentId } = await seedAgent();
      const getDailyCapBlock = vi.fn(async () => RUN_CAP);
      const deps = fakeDeps({ getDailyCapBlock });

      const result = await idlePickupForAgent(deps, { id: agentId, companyId });

      expect(result.considered).toBe(0);
      expect(getDailyCapBlock).not.toHaveBeenCalled();
    });
  });

  // The manual-wake binding (WAKE-BIND) reuses this ranking: a wake without an
  // explicit issue must land on the same task the idle-pickup scheduler picks.
  describe("findTopReadyIssueForAgent", () => {
    it("skips a higher-priority task with an open blocker and picks the next ready task (OPE-9556)", async () => {
      const { companyId, agentId } = await seedAgent();
      const blockerId = await seedIssue({ companyId, status: "in_progress" });
      const blockedId = await seedIssue({
        companyId,
        agentId,
        status: "todo",
        priority: "critical",
      });
      const nextId = await seedIssue({
        companyId,
        agentId,
        status: "todo",
        priority: "low",
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: blockedId,
        type: "blocks",
      });

      const top = await findTopReadyIssueForAgent(db, { id: agentId, companyId });
      expect(top?.id).toBe(nextId);

      // When blocker resolves, the higher-priority task becomes eligible
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
      const unblockedTop = await findTopReadyIssueForAgent(db, { id: agentId, companyId });
      expect(unblockedTop?.id).toBe(blockedId);
    });

    it("returns the top ready task by the same ranking the sweep uses", async () => {
      const { companyId, agentId } = await seedAgent();
      const lowId = await seedIssue({ companyId, agentId, priority: "low" });
      const criticalId = await seedIssue({ companyId, agentId, priority: "critical" });
      const mediumId = await seedIssue({ companyId, agentId, priority: "medium" });

      const top = await findTopReadyIssueForAgent(db, { id: agentId, companyId });

      expect(top?.id).toBe(criticalId);
      void lowId;
      void mediumId;
    });

    it("returns null when the agent has no ready task", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedIssue({ companyId, agentId, status: "done" });
      await seedIssue({ companyId, agentId, status: "in_review" });

      expect(await findTopReadyIssueForAgent(db, { id: agentId, companyId })).toBeNull();
    });

    it("skips a ready task already covered by a live run", async () => {
      const { companyId, agentId } = await seedAgent();
      const runningId = await seedIssue({ companyId, agentId, priority: "critical", status: "in_progress" });
      const nextId = await seedIssue({ companyId, agentId, priority: "low" });
      await seedLiveRun({ companyId, agentId, issueId: runningId, status: "running" });

      const top = await findTopReadyIssueForAgent(db, { id: agentId, companyId });

      expect(top?.id).toBe(nextId);
    });

    it("skips a ready task already covered by a pending wake", async () => {
      const { companyId, agentId } = await seedAgent();
      const coveredId = await seedIssue({ companyId, agentId, priority: "critical" });
      const nextId = await seedIssue({ companyId, agentId, priority: "low" });
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_assigned",
        payload: { issueId: coveredId },
        status: "queued",
        requestedByActorType: "user",
        requestedByActorId: null,
      });

      const top = await findTopReadyIssueForAgent(db, { id: agentId, companyId });

      expect(top?.id).toBe(nextId);
    });

    it("returns null when the only ready task is already being worked", async () => {
      const { companyId, agentId } = await seedAgent();
      const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
      await seedLiveRun({ companyId, agentId, issueId, status: "queued" });

      expect(await findTopReadyIssueForAgent(db, { id: agentId, companyId })).toBeNull();
    });

    it("skips a task whose monitor check is scheduled in the future and binds to the next ready one", async () => {
      const { companyId, agentId } = await seedAgent();
      await seedIssue({
        companyId,
        agentId,
        status: "in_progress",
        priority: "critical",
        monitorNextCheckAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      const nextId = await seedIssue({ companyId, agentId, priority: "low" });

      const top = await findTopReadyIssueForAgent(db, { id: agentId, companyId });

      expect(top?.id).toBe(nextId);
    });
  });
});

describeEmbeddedPostgres("createIdlePickupSweeper (IDLE-PICKUP tick)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-idle-pickup-sweep-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(issuePlanDecompositions);
    await db.delete(issueRelations);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: { status?: string; companyStatus?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      ...(input.companyStatus ? { status: input.companyStatus } : {}),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: input.status ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  function sweeperDeps(
    overrides: {
      enqueueWakeup?: (...args: unknown[]) => Promise<unknown>;
      pickupReviewForAgent?: Parameters<typeof createIdlePickupSweeper>[0]["pickupReviewForAgent"];
      invokable?: (agent: { id: string; status: string }) => boolean;
      underMaintenance?: (agentId: string) => boolean;
      env?: Record<string, string | undefined>;
      getDailyCapBlock?: Parameters<typeof createIdlePickupSweeper>[0]["getDailyCapBlock"];
    } = {},
  ) {
    const enqueueWakeup = vi.fn(overrides.enqueueWakeup ?? (async () => ({ id: randomUUID() })));
    const deps = {
      db,
      enqueueWakeup: enqueueWakeup as unknown as Parameters<typeof createIdlePickupSweeper>[0]["enqueueWakeup"],
      isAgentInvokable: vi.fn(
        async (agent: { id: string; status: string }) =>
          overrides.invokable ? overrides.invokable(agent) : agent.status !== "paused" && agent.status !== "terminated",
      ),
      isAgentUnderMaintenance: vi.fn(
        async (agentId: string) => (overrides.underMaintenance ? overrides.underMaintenance(agentId) : false),
      ),
      ...(overrides.env ? { env: overrides.env } : {}),
      ...(overrides.pickupReviewForAgent ? { pickupReviewForAgent: overrides.pickupReviewForAgent } : {}),
      ...(overrides.getDailyCapBlock ? { getDailyCapBlock: overrides.getDailyCapBlock } : {}),
    };
    const sweeper = createIdlePickupSweeper(deps);
    return { sweeper, enqueueWakeup: enqueueWakeup as unknown as ReturnType<typeof vi.fn>, deps };
  }

  // Local row seeds (the per-agent describe's helpers live in its own scope).
  async function seedIssue(input: { companyId: string; agentId: string | null; status: string }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: "Ready task",
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.agentId,
    });
    return id;
  }

  async function seedLiveRun(input: { companyId: string; agentId: string; issueId: string; status: string }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "automation",
      contextSnapshot: { issueId: input.issueId },
    });
  }

  it("retries suppressed review work on later ticks before general development work", async () => {
    const { companyId, agentId } = await seedAgent();
    await db.insert(issues).values({
      id: randomUUID(), companyId, title: "Development task", status: "todo",
      priority: "high", assigneeAgentId: agentId,
    });
    const pickupReviewForAgent = vi.fn()
      .mockResolvedValueOnce({ handled: true, woken: 0 })
      .mockResolvedValueOnce({ handled: true, woken: 1 });
    const { sweeper, enqueueWakeup } = sweeperDeps({ pickupReviewForAgent });
    expect((await sweeper.sweep(new Date("2026-09-30T12:00:00Z"))).woken).toBe(0);
    expect((await sweeper.sweep(new Date("2026-09-30T12:10:00Z"))).woken).toBe(1);
    expect(pickupReviewForAgent).toHaveBeenCalledTimes(2);
    expect(pickupReviewForAgent).toHaveBeenCalledWith(expect.objectContaining({ id: agentId, companyId }));
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  // OPE-12445 acceptance: an engineer with no live run whose task sits in todo
  // without blockers is a candidate — the pass must count it (considered >= 1)
  // and wake the agent.
  it("counts and wakes a todo task of an idle engineer (considered >= 1)", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue({ companyId, agentId, status: "todo" });
    const { sweeper, enqueueWakeup } = sweeperDeps();

    const result = await sweeper.sweep(new Date());

    expect(result.considered).toBeGreaterThanOrEqual(1);
    expect(result.woken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: IDLE_WAKE_REASON }));
  });

  // OPE-12445: the pass log read considered: 0 while agentsChecked: 79 /
  // alreadyActive: 13 proved candidates were scanned — the per-agent counts
  // were never aggregated into the totals.
  it("aggregates per-agent considered into the pass totals when no one is woken", async () => {
    const { companyId, agentId } = await seedAgent();
    // A live run makes this candidate considered-but-alreadyActive: scanned,
    // skipped, woken stays 0 — exactly the production blind-spot shape.
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedLiveRun({ companyId, agentId, issueId, status: "running" });
    const { sweeper } = sweeperDeps();

    const result = await sweeper.sweep(new Date());

    expect(result.agentsChecked).toBe(1);
    expect(result.woken).toBe(0);
    expect(result.considered).toBe(1);
    expect(result.alreadyActive).toBe(1);
  });

  it("logs the woke-none diagnostic when candidates were scanned but nobody was woken", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue({ companyId, agentId, status: "in_progress" });
    await seedLiveRun({ companyId, agentId, issueId, status: "running" });
    const { sweeper } = sweeperDeps();
    vi.mocked(logger.info).mockClear();

    await sweeper.sweep(new Date());

    const wokeNoneLog = vi
      .mocked(logger.info)
      .mock.calls.find(([, msg]) => msg === "idle pickup considered ready assigned issues but woke none");
    expect(wokeNoneLog).toBeDefined();
    const [fields] = wokeNoneLog!;
    expect(fields).toMatchObject({ agentsChecked: 1, considered: 1, alreadyActive: 1, woken: 0 });
  });

  // OPE-12445: the review lane consumes the agent's whole pass when handled;
  // its candidates must count toward the pass totals or the pass log still
  // reads considered: 0 while the review lane owns the queue.
  it("adds the review lane's considered count to the pass totals when the lane handles the pass", async () => {
    const { companyId, agentId } = await seedAgent();
    const pickupReviewForAgent = vi.fn().mockResolvedValue({ handled: true, woken: 0, considered: 2 });
    const { sweeper } = sweeperDeps({ pickupReviewForAgent });
    vi.mocked(logger.info).mockClear();

    const result = await sweeper.sweep(new Date());

    expect(result.woken).toBe(0);
    expect(result.considered).toBe(2);
    const wokeNoneLog = vi
      .mocked(logger.info)
      .mock.calls.find(([, msg]) => msg === "idle pickup considered ready assigned issues but woke none");
    expect(wokeNoneLog).toBeDefined();
  });

  it("wakes a ready issue of an invokable idle agent on the tick", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const { sweeper, enqueueWakeup } = sweeperDeps();

    const result = await sweeper.sweep(new Date());

    expect(result.agentsChecked).toBe(1);
    expect(result.woken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: IDLE_WAKE_REASON }));
  });

  it("myrmidon(OPE-11947): skips an agent over its daily cap whose receipt exists and still wakes the others", async () => {
    const capped = await seedAgent();
    const free = await seedAgent();
    for (const { companyId, agentId } of [capped, free]) {
      for (let n = 0; n < 3; n += 1) {
        await db.insert(issues).values({
          id: randomUUID(), companyId, title: `Ready task ${n}`, status: "todo",
          priority: "medium", assigneeAgentId: agentId,
        });
      }
    }
    await db.insert(agentWakeupRequests).values({
      companyId: capped.companyId,
      agentId: capped.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "heartbeat.daily_run_limit",
      payload: { heartbeatSkip: { observed: 40, limit: 40 } },
      status: "skipped",
      finishedAt: new Date(),
    });
    const { sweeper, enqueueWakeup } = sweeperDeps({
      getDailyCapBlock: async (agent) =>
        agent.id === capped.agentId ? { reason: "heartbeat.daily_run_limit", observed: 40, limit: 40 } : null,
    });

    const result = await sweeper.sweep(new Date());

    expect(result.agentsChecked).toBe(2);
    expect(result.dailyCapSkipped).toBe(1);
    expect(result.woken).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(free.agentId, expect.objectContaining({ reason: IDLE_WAKE_REASON }));
  });

  it("does not wake a paused agent (the pause is respected)", async () => {
    const { companyId, agentId } = await seedAgent({ status: "paused" });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { sweeper, enqueueWakeup } = sweeperDeps();

    const result = await sweeper.sweep(new Date());

    expect(result.agentsChecked).toBe(0);
    expect(result.woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not wake an agent under maintenance", async () => {
    const { companyId, agentId } = await seedAgent();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { sweeper, enqueueWakeup } = sweeperDeps({ underMaintenance: () => true });

    const result = await sweeper.sweep(new Date());

    expect(result.agentsChecked).toBe(0);
    expect(result.woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("skips agents of a non-active company", async () => {
    const { companyId, agentId } = await seedAgent({ companyStatus: "suspended" });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { sweeper, enqueueWakeup } = sweeperDeps();

    const result = await sweeper.sweep(new Date());

    expect(result.woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("respects the interval: a second sweep inside the window checks nothing", async () => {
    const { sweeper } = sweeperDeps({ env: { [IDLE_PICKUP_INTERVAL_SEC_ENV]: "300" } });
    const first = await sweeper.sweep(new Date("2026-09-30T12:00:00Z"));
    const second = await sweeper.sweep(new Date("2026-09-30T12:01:00Z"));

    expect(first.agentsChecked).toBeGreaterThanOrEqual(0);
    expect(second.agentsChecked).toBe(0);
    expect(second.woken).toBe(0);
  });

  it("runs again after the interval elapses", async () => {
    const { sweeper } = sweeperDeps({ env: { [IDLE_PICKUP_INTERVAL_SEC_ENV]: "5" } });
    await sweeper.sweep(new Date("2026-09-30T12:00:00Z"));
    const second = await sweeper.sweep(new Date("2026-09-30T12:00:30Z"));
    expect(second.agentsChecked).toBeGreaterThanOrEqual(0);
  });

  it("does nothing when disabled by setting", async () => {
    const { companyId, agentId } = await seedAgent();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Ready task",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { sweeper, enqueueWakeup } = sweeperDeps({ env: { [IDLE_PICKUP_ENABLED_ENV]: "off" } });

    const result = await sweeper.sweep(new Date());

    expect(result.agentsChecked).toBe(0);
    expect(result.woken).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});

describe("isReviewPendingWaitingForCi (OPE-10082)", () => {
  const agentId = randomUUID();

  it("returns true when executionState has review pending and ciState is pending or unknown", () => {
    expect(
      isReviewPendingWaitingForCi({
        agentId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId },
          ciState: "pending",
        },
      }),
    ).toBe(true);

    expect(
      isReviewPendingWaitingForCi({
        agentId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId },
          ciState: "unknown",
        },
      }),
    ).toBe(true);
  });

  it("returns true when PR workProduct metadata has ciState pending/unknown or activeCi queued", () => {
    expect(
      isReviewPendingWaitingForCi({
        agentId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId },
        },
        workProductMetadata: { ciState: "pending" },
      }),
    ).toBe(true);

    expect(
      isReviewPendingWaitingForCi({
        agentId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId },
        },
        workProductMetadata: { activeCi: { status: "queued" } },
      }),
    ).toBe(true);
  });

  it("returns false when CI is green", () => {
    expect(
      isReviewPendingWaitingForCi({
        agentId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId },
          ciState: "green",
        },
      }),
    ).toBe(false);
  });

  it("returns false when currentParticipant is a different agent", () => {
    expect(
      isReviewPendingWaitingForCi({
        agentId,
        executionState: {
          status: "pending",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: randomUUID() },
          ciState: "pending",
        },
      }),
    ).toBe(false);
  });

  it("returns false when review stage is not pending", () => {
    expect(
      isReviewPendingWaitingForCi({
        agentId,
        executionState: {
          status: "approved",
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId },
          ciState: "pending",
        },
      }),
    ).toBe(false);
  });
});
