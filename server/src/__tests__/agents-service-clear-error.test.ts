import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@myrmidon/db";
import { issueExecutionStateSchema } from "@myrmidon/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service clearError", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-clear-error-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reassigns an agent's assignee, returnAssignee, and currentParticipant work to one least-loaded same-role agent", async () => {
    const companyId = randomUUID();
    const terminatedId = randomUUID();
    const replacementId = randomUUID();
    const otherEngineerId = randomUUID();
    const qaId = randomUUID();
    const returnBackupId = randomUUID();
    const participantBackupId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Termination reassignment", issuePrefix: `TR${companyId.slice(0, 6).toUpperCase()}` });
    const agentValues = (id: string, name: string, role: string) => ({
      id, companyId, name, role, status: "active" as const, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agents).values([
      agentValues(terminatedId, "Departing Engineer", "engineer"),
      agentValues(replacementId, "Replacement Engineer", "engineer"),
      agentValues(otherEngineerId, "Busy Engineer", "engineer"),
      agentValues(qaId, "QA Agent", "qa"),
      agentValues(returnBackupId, "Return Backup", "engineer"),
      agentValues(participantBackupId, "Participant Backup", "engineer"),
    ]);
    const state = (principal: { type: "agent"; agentId: string }) => ({
      status: "pending", currentStageId: null, currentStageIndex: null, currentStageType: "review",
      currentParticipant: principal, returnAssignee: principal, completedStageIds: [], lastDecisionId: null,
      lastDecisionOutcome: null, monitor: null,
    });
    const issueIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issues).values([
      { id: issueIds[0], companyId, identifier: "TR-1", title: "Assignee", status: "in_progress", assigneeAgentId: terminatedId },
      { id: issueIds[1], companyId, identifier: "TR-2", title: "Return", status: "in_progress", executionState: state({ type: "agent", agentId: terminatedId }) },
      { id: issueIds[2], companyId, identifier: "TR-3", title: "Participant", status: "in_progress", executionState: { ...state({ type: "agent", agentId: terminatedId }), returnAssignee: null } },
      { id: issueIds[3], companyId, identifier: "TR-4", title: "Return backup load", status: "in_progress", assigneeAgentId: returnBackupId },
      { id: issueIds[4], companyId, identifier: "TR-5", title: "Participant backup load", status: "in_progress", assigneeAgentId: participantBackupId },
      { id: issueIds[5], companyId, identifier: "TR-6", title: "Other engineer load", status: "in_progress", assigneeAgentId: otherEngineerId },
      { companyId, identifier: "TR-7", title: "Other engineer load", status: "in_progress", assigneeAgentId: otherEngineerId },
    ]);

    const initialWorkload = await db.select().from(issues).where(eq(issues.companyId, companyId));
    const initialAgentRows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const initialLiveEngineers = initialAgentRows.filter((agent) => agent.role === "engineer" && agent.status !== "terminated" && agent.status !== "retired");
    const initialLoad = (agentId: string) => initialWorkload.filter((row) => row.assigneeAgentId === agentId && row.status !== "done" && row.status !== "cancelled").length;
    const leastLoadedBeforeTermination = initialLiveEngineers.reduce((best, agent) => initialLoad(agent.id) < initialLoad(best.id) || (initialLoad(agent.id) === initialLoad(best.id) && agent.id.localeCompare(best.id) < 0) ? agent : best);
    expect(leastLoadedBeforeTermination.id).toBe(replacementId);

    const expectedReplacements = new Map([
      [issueIds[0], leastLoadedBeforeTermination.id],
      [issueIds[1], leastLoadedBeforeTermination.id],
      [issueIds[2], leastLoadedBeforeTermination.id],
    ]);
    const replacementNames = new Map(initialAgentRows.map((agent) => [agent.id, agent.name]));
    await agentService(db).terminate(terminatedId);

    const roleNames = new Map([
      [replacementId, "Replacement Engineer"],
      [returnBackupId, "Return Backup"],
      [participantBackupId, "Participant Backup"],
    ]);
    const workload = await db.select().from(issues).where(eq(issues.companyId, companyId));
    const agentRows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    const liveEngineers = agentRows.filter((agent) => agent.role === "engineer" && agent.status !== "terminated" && agent.status !== "retired");
    const assigneeLoad = (agentId: string) => workload.filter((row) => row.assigneeAgentId === agentId && row.status !== "done" && row.status !== "cancelled").length;
    const leastLoaded = liveEngineers.reduce((best, agent) => assigneeLoad(agent.id) < assigneeLoad(best.id) || (assigneeLoad(agent.id) === assigneeLoad(best.id) && agent.id.localeCompare(best.id) < 0) ? agent : best);
    expect(leastLoaded.id).toBe(replacementId);
    for (const id of issueIds.slice(0, 3)) {
      const issue = workload.find((row) => row.id === id)!;
      const roleAssignment = expectedReplacements.get(id)!;
      const expectedRole = replacementNames.get(roleAssignment)!;
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, id));
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        authorType: "system",
        body: expect.stringContaining(`Terminated agent Departing Engineer was replaced by ${expectedRole} for open work.`),
      });
      expect(issue.assigneeAgentId).toBe(id === issueIds[0] ? replacementId : null);
      const parsed = issueExecutionStateSchema.safeParse(issue.executionState);
      if (id === issueIds[0]) {
        expect(parsed.success).toBe(false);
        continue;
      }
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.currentParticipant).toEqual({ type: "agent", agentId: roleAssignment });
        expect(parsed.data.returnAssignee).toEqual(id === issueIds[1] ? { type: "agent", agentId: returnBackupId } : null);
      }
    }
    const comments = await db.select().from(issueComments).where(eq(issueComments.companyId, companyId));
    expect(comments).toHaveLength(3);
    expect(comments.every((comment) => comment.authorType === "system" && comment.body).valueOf()).toBe(true);
  });
  it("resets converted agent sessions while preserving identity, configuration and run history", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const config = { cwd: "/tmp/runner-conversion", instructionsFilePath: "/tmp/runner-conversion/AGENTS.md", env: { TEST_KEY: { type: "plain", value: "kept" } } };
    await db.insert(companies).values({ id: companyId, name: "Conversion", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claude QA", role: "engineer", adapterType: "claude_local", adapterConfig: config });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded", resultJson: { summary: "history stays" } });
    await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "claude_local", taskKey: "issue:test", sessionDisplayId: "old-session", lastRunId: runId });
    await db.insert(agentRuntimeState).values({ companyId, agentId, adapterType: "claude_local", sessionId: "old-session", stateJson: { old: true }, lastRunId: runId });
    const updated = await agentService(db).update(agentId, { adapterType: "paperclip_runner", adapterConfig: { ...config, provider: "acpx", acpxAgent: "claude", model: "custom-claude-model" } });
    expect(updated).toMatchObject({ id: agentId, companyId, name: "Claude QA", role: "engineer", adapterConfig: config });
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId))).toEqual([]);
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime).toMatchObject({ adapterType: "paperclip_runner", sessionId: null, stateJson: {}, lastRunId: runId });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({ status: "succeeded", resultJson: { summary: "history stays" } });
  });

  it("moves an error agent to idle without deleting run history or runtime diagnostics", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "error",
      pauseReason: "system",
      pausedAt: new Date("2026-06-07T00:00:00.000Z"),
      errorReason: "Secret is not bound to agent at env.ANTHROPIC_API_KEY",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      error: "Adapter exited with code 1",
      stdoutExcerpt: "stdout stays inspectable",
      stderrExcerpt: "stderr stays inspectable",
      logStore: "local_disk",
      logRef: "runs/failed.log",
      resultJson: { sessionId: "codex-session-1" },
      finishedAt: new Date("2026-06-07T00:01:00.000Z"),
    });

    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "transcript",
      stream: "stderr",
      message: "transcript stays inspectable",
      payload: { itemType: "error" },
    });

    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      sessionId: "codex-session-1",
      stateJson: { taskKey: "issue:test" },
      lastRunId: runId,
      lastRunStatus: "failed",
      lastError: "Adapter exited with code 1",
    });

    const cleared = await agentService(db).clearError(agentId);

    expect(cleared).toMatchObject({
      id: agentId,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      errorReason: null,
    });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({
      id: runId,
      status: "failed",
      error: "Adapter exited with code 1",
      stdoutExcerpt: "stdout stays inspectable",
      stderrExcerpt: "stderr stays inspectable",
      logStore: "local_disk",
      logRef: "runs/failed.log",
    });

    const transcriptEvents = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(transcriptEvents).toHaveLength(1);
    expect(transcriptEvents[0]).toMatchObject({
      runId,
      eventType: "transcript",
      stream: "stderr",
      message: "transcript stays inspectable",
      payload: { itemType: "error" },
    });

    const [runtimeState] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    expect(runtimeState).toMatchObject({
      agentId,
      sessionId: "codex-session-1",
      stateJson: { taskKey: "issue:test" },
      lastRunId: runId,
      lastRunStatus: "failed",
      lastError: "Adapter exited with code 1",
    });
  });

  it("rejects non-error agents with a 409 conflict", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(agentService(db).clearError(agentId)).rejects.toMatchObject({
      status: 409,
      message: "Only agents in error status can have their error cleared",
    });
  });

  it("keeps resume-style terminal and pending-approval protections", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();
    const pendingAgentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: terminatedAgentId,
        companyId,
        name: "Terminated",
        role: "engineer",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await expect(agentService(db).clearError(terminatedAgentId)).rejects.toMatchObject({
      status: 409,
      message: "Cannot clear error on terminated agent",
    });
    await expect(agentService(db).clearError(pendingAgentId)).rejects.toMatchObject({
      status: 409,
      message: "Pending approval agents cannot have errors cleared",
    });
  });
});
