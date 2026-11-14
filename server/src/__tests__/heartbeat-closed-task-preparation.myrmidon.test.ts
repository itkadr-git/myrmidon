import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunContinuations,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import * as adapterModule from "../adapters/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat closed task preparation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("heartbeat closed task preparation (OPE-13088)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;
  let previousJwtSecret: string | undefined;

  beforeAll(async () => {
    previousJwtSecret = process.env.MYRMIDON_AGENT_JWT_SECRET;
    if (previousJwtSecret === undefined) {
      process.env.MYRMIDON_AGENT_JWT_SECRET = "vitest-agent-jwt-secret";
    }
    tempDb = await startEmbeddedPostgresTestDatabase(
      "heartbeat-closed-task-prep-",
    );
    db = createDb(tempDb.connectionString);
  }, 60_000);

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message =
      error instanceof Error
        ? `${error.message} ${String(error.cause ?? "")}`
        : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk") ||
      message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunContinuations);
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  afterEach(async () => {
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousJwtSecret === undefined) {
      delete process.env.MYRMIDON_AGENT_JWT_SECRET;
    } else {
      process.env.MYRMIDON_AGENT_JWT_SECRET = previousJwtSecret;
    }
  });

  async function seedAgentAndIssue(issueStatus: "todo" | "in_progress" | "done" | "cancelled" = "todo") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Closed task preparation issue",
      status: issueStatus,
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  it("cancels run cleanly when task is closed after dequeue before preparation without failing", async () => {
    const { companyId, agentId, issueId } = await seedAgentAndIssue("in_progress");
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    // Task is marked done after run was claimed from queue, before preparation
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(issues.id, issueId));

    const executeSpy = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: {},
    }));
    vi.spyOn(adapterModule, "getServerAdapter").mockReturnValue({
      supportsLocalAgentJwt: false,
      execute: executeSpy,
    } as never);

    const heartbeat = heartbeatService(db);
    await heartbeat.executeRunForGatewayReattach(runId, "gateway-test-id");
    await heartbeat.drainActiveRunExecutions();

    expect(executeSpy).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(run?.error).toContain(
      "Cancelled because issue reached terminal status (done) before execution could start",
    );

    const [agent] = await db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent?.status).toBe("idle");
    expect(agent?.errorReason).toBeNull();
  });

  it("cancels run cleanly when task is cancelled after dequeue before preparation", async () => {
    const { companyId, agentId, issueId } = await seedAgentAndIssue("in_progress");
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    // Task is marked cancelled after run was claimed from queue, before preparation
    await db
      .update(issues)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(issues.id, issueId));

    const executeSpy = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: {},
    }));
    vi.spyOn(adapterModule, "getServerAdapter").mockReturnValue({
      supportsLocalAgentJwt: false,
      execute: executeSpy,
    } as never);

    const heartbeat = heartbeatService(db);
    await heartbeat.executeRunForGatewayReattach(runId, "gateway-test-id");
    await heartbeat.drainActiveRunExecutions();

    expect(executeSpy).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(run?.error).toContain(
      "Cancelled because issue reached terminal status (cancelled) before execution could start",
    );
  });

  it("cancels run cleanly with resumeIntent on a closed task", async () => {
    const { companyId, agentId, issueId } = await seedAgentAndIssue("done");
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        resumeIntent: true,
      },
    });

    const executeSpy = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: {},
    }));
    vi.spyOn(adapterModule, "getServerAdapter").mockReturnValue({
      supportsLocalAgentJwt: false,
      execute: executeSpy,
    } as never);

    const heartbeat = heartbeatService(db);
    await heartbeat.executeRunForGatewayReattach(runId, "gateway-test-id");
    await heartbeat.drainActiveRunExecutions();

    expect(executeSpy).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_terminal_status");
    expect(run?.error).toContain(
      "Cancelled because issue reached terminal status (done) before execution could start",
    );

    const [agent] = await db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent?.status).toBe("idle");
    expect(agent?.errorReason).toBeNull();
  });
});
