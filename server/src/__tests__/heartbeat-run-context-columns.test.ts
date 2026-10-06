// OPE-5007 П2: the run list and the attention feed read the thin
// context_issue_* columns, with a context_snapshot coalesce fallback that
// keeps historical rows (no columns) working.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  runContextPersistenceFields,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { listAttentionExhaustedRuns } from "../services/attention-exhausted-runs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping run-context-column tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat run context columns", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-context-cols-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Cols Paperclip",
      issuePrefix: "COL",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ColsCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("list() falls back to context_snapshot for historical rows without thin columns", async () => {
    const issueId = randomUUID();
    const oldRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: oldRunId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: {
        issueId,
        taskId: "task-old",
        taskKey: "COL-1",
        commentId: "comment-old",
        wakeCommentId: "wake-comment-old",
        wakeReason: "issue_commented",
        wakeSource: "user",
        wakeTriggerDetail: "manual",
        prompt: "x".repeat(8_000),
      },
    });

    const runs = await heartbeatService(db).list(companyId, agentId, 10);
    const row = runs.find((candidate) => candidate.id === oldRunId);
    expect(row?.contextSnapshot).toMatchObject({
      issueId,
      taskId: "task-old",
      taskKey: "COL-1",
      commentId: "comment-old",
      wakeCommentId: "wake-comment-old",
      wakeReason: "issue_commented",
      wakeSource: "user",
      wakeTriggerDetail: "manual",
    });
  });

  it("list() reads new rows from the thin columns and rows write all nine via the helper", async () => {
    const issueId = randomUUID();
    const runId = randomUUID();
    const contextSnapshot = {
      issueId,
      taskId: issueId,
      taskKey: "COL-2",
      commentId: "comment-2",
      wakeCommentId: "wake-comment-2",
      wakeReason: "issue_assigned",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
      taskTitle: "OPE-5007: thin columns",
      executionContinuation: { objective: "big envelope", messages: [{ id: "m1" }] },
      prompt: "y".repeat(8_000),
    };
    await db
      .insert(heartbeatRuns)
      .values({ id: runId, companyId, agentId, status: "succeeded", ...runContextPersistenceFields(contextSnapshot) });

    // The persisted snapshot no longer carries the continuation duplicate,
    // while the wake payload path (built from the in-memory context) does.
    const persisted = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
    expect(persisted.contextSnapshot).not.toHaveProperty("executionContinuation");
    expect(persisted.contextIssueId).toBe(issueId);
    expect(persisted.contextTaskId).toBe(issueId);
    expect(persisted.contextTaskKey).toBe("COL-2");
    expect(persisted.contextCommentId).toBe("comment-2");
    expect(persisted.contextWakeCommentId).toBe("wake-comment-2");
    expect(persisted.contextWakeReason).toBe("issue_assigned");
    expect(persisted.contextWakeSource).toBe("automation");
    expect(persisted.contextWakeTriggerDetail).toBe("system");
    expect(persisted.contextRunSummary).toBe("OPE-5007: thin columns");

    const runs = await heartbeatService(db).list(companyId, agentId, 10);
    const row = runs.find((candidate) => candidate.id === runId);
    expect(row?.contextSnapshot).toMatchObject({
      issueId,
      taskKey: "COL-2",
      wakeReason: "issue_assigned",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
    });
  });

  it("the attention exhausted-runs feed reads ids from columns for new rows and from the snapshot for old rows", async () => {
    const issueId = randomUUID();
    const taskOnlyIssueId = randomUUID();
    const oldRunId = randomUUID();
    const newRunId = randomUUID();

    // Historical row: snapshot only.
    await db.insert(heartbeatRuns).values({
      id: oldRunId,
      companyId,
      agentId,
      status: "failed",
      error: "boom",
      contextSnapshot: { issueId, prompt: "z".repeat(8_000) },
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      agentId,
      runId: oldRunId,
      seq: 1,
      eventType: "lifecycle",
      message: "Bounded retry exhausted receipt old",
    });

    // New row: thin columns filled, snapshot stripped by the helper.
    await db
      .insert(heartbeatRuns)
      .values({
        id: newRunId,
        companyId,
        agentId,
        status: "timed_out",
        error: "slow",
        ...runContextPersistenceFields({
          taskId: taskOnlyIssueId,
          executionContinuation: { objective: "keep going" },
        }),
      });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      agentId,
      runId: newRunId,
      seq: 1,
      eventType: "lifecycle",
      message: "Bounded retry exhausted receipt new",
    });

    const rows = await listAttentionExhaustedRuns(db, companyId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === oldRunId)).toMatchObject({
      runIssueId: issueId,
      runTaskId: null,
    });
    expect(rows.find((row) => row.id === newRunId)).toMatchObject({
      runIssueId: null,
      runTaskId: taskOnlyIssueId,
    });
    // No full snapshot travels to the feed: the projection carries two ids only.
    expect(rows.find((row) => row.id === newRunId)).not.toHaveProperty("contextSnapshot");
  });
});
