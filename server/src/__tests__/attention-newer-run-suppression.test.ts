import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  inboxDismissals,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { attentionService } from "../services/attention.js";

// Semantics of the failed_run suppression check: an exhausted run leaves the
// attention feed when ANY newer run of the same agent carries the same task
// key (context_snapshot issueId, else taskId, else the empty key). The check
// must answer one EXISTS per failed run against the ctx expression indexes
// instead of reading every newer run's context_snapshot.
// The attention feed only lists failed runs inside the failed-run horizon (default 7 days,
// ATTENTION-WINDOW-CACHE), so the seeded runs are anchored to the present: a fixed calendar
// date silently ages out of the window and the feed comes back empty.
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000;
const minuteAt = (minute: number) => new Date(BASE_MS + minute * 60_000);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres failed-run suppression tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("attention failed-run newer-run suppression", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-newer-run-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(inboxDismissals);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(prefix: string) {
    const companyId = randomUUID();
    const workerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Co`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: workerId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, workerId };
  }

  async function insertExhaustedFailure(input: {
    companyId: string;
    agentId: string;
    contextSnapshot: Record<string, unknown> | null;
    createdAt: Date;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: input.contextSnapshot,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      finishedAt: input.createdAt,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      runId: id,
      agentId: input.agentId,
      seq: 1,
      eventType: "lifecycle",
      message: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      createdAt: new Date(input.createdAt.getTime() + 1000),
    });
    return id;
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    contextSnapshot: Record<string, unknown> | null;
    createdAt: Date;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status: input.status,
      contextSnapshot: input.contextSnapshot,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      finishedAt: input.createdAt,
    });
    return id;
  }

  function failedRunIds(feed: { items: Array<{ sourceKind: string; subject: { id: string } }> }) {
    return feed.items
      .filter((item) => item.sourceKind === "failed_run")
      .map((item) => item.subject.id)
      .sort();
  }

  it("hides a failed run when the same agent ran the same issue key later", async () => {
    const { companyId, workerId } = await seedAgent("SUP");
    const issueId = randomUUID();
    const failedId = await insertExhaustedFailure({
      companyId,
      agentId: workerId,
      contextSnapshot: { issueId },
      createdAt: minuteAt(0),
    });
    await insertRun({
      companyId,
      agentId: workerId,
      status: "succeeded",
      contextSnapshot: { issueId },
      createdAt: minuteAt(5),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(failedRunIds(feed)).not.toContain(failedId);
  });

  it("keeps a failed run when the newer run of the same agent is on another issue", async () => {
    const { companyId, workerId } = await seedAgent("SUP");
    const failedId = await insertExhaustedFailure({
      companyId,
      agentId: workerId,
      contextSnapshot: { issueId: randomUUID() },
      createdAt: minuteAt(0),
    });
    await insertRun({
      companyId,
      agentId: workerId,
      status: "succeeded",
      contextSnapshot: { issueId: randomUUID() },
      createdAt: minuteAt(5),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(failedRunIds(feed)).toContain(failedId);
  });

  it("matches the taskId key when the failed run has no issueId", async () => {
    const { companyId, workerId } = await seedAgent("SUP");
    const taskId = randomUUID();
    const failedId = await insertExhaustedFailure({
      companyId,
      agentId: workerId,
      contextSnapshot: { taskId },
      createdAt: minuteAt(0),
    });
    const otherTaskFailedId = await insertExhaustedFailure({
      companyId,
      agentId: workerId,
      contextSnapshot: { taskId: randomUUID() },
      createdAt: minuteAt(0),
    });
    await insertRun({
      companyId,
      agentId: workerId,
      status: "succeeded",
      contextSnapshot: { taskId },
      createdAt: minuteAt(5),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(failedRunIds(feed)).not.toContain(failedId);
    expect(failedRunIds(feed)).toContain(otherTaskFailedId);
  });

  it("uses the empty key for a failed run without issueId or taskId", async () => {
    const { companyId, workerId } = await seedAgent("SUP");
    const failedId = await insertExhaustedFailure({
      companyId,
      agentId: workerId,
      contextSnapshot: null,
      createdAt: minuteAt(0),
    });
    // A newer keyed run must NOT suppress the empty-key failure.
    await insertRun({
      companyId,
      agentId: workerId,
      status: "succeeded",
      contextSnapshot: { issueId: randomUUID() },
      createdAt: minuteAt(3),
    });

    const keyedFeed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(failedRunIds(keyedFeed)).toContain(failedId);

    // A newer empty-key run of the same agent suppresses it.
    await insertRun({
      companyId,
      agentId: workerId,
      status: "running",
      contextSnapshot: null,
      createdAt: minuteAt(6),
    });

    const emptyKeyFeed = await attentionService(db).list(companyId, { userId: "board-user" });
    expect(failedRunIds(emptyKeyFeed)).not.toContain(failedId);
  });

  it("does not let a failed run match itself, even at equal created_at", async () => {
    const { companyId, workerId } = await seedAgent("SUP");
    const issueId = randomUUID();
    const at = minuteAt(0);
    const failedId = await insertExhaustedFailure({
      companyId,
      agentId: workerId,
      contextSnapshot: { issueId },
      createdAt: at,
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(failedRunIds(feed)).toContain(failedId);
  });

  it("only a run of the same agent suppresses the failure", async () => {
    const { companyId, workerId } = await seedAgent("SUP");
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    const failedId = await insertExhaustedFailure({
      companyId,
      agentId: workerId,
      contextSnapshot: { issueId },
      createdAt: minuteAt(0),
    });
    await insertRun({
      companyId,
      agentId: otherAgentId,
      status: "succeeded",
      contextSnapshot: { issueId },
      createdAt: minuteAt(5),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(failedRunIds(feed)).toContain(failedId);
    // The worker itself stayed referenced by the failure row.
    const failure = feed.items.find((item) => item.sourceKind === "failed_run");
    expect(failure?.subject.metadata?.agentId).toBe(workerId);
  });

  it("keeps suppression scoped to the run's company", async () => {
    const { companyId, workerId } = await seedAgent("SUP");
    const other = await seedAgent("OSP");
    const issueId = randomUUID();
    const failedId = await insertExhaustedFailure({
      companyId,
      agentId: workerId,
      contextSnapshot: { issueId },
      createdAt: minuteAt(0),
    });
    // Same key, same created window, but another company: must not suppress.
    await insertRun({
      companyId: other.companyId,
      agentId: other.workerId,
      status: "succeeded",
      contextSnapshot: { issueId },
      createdAt: minuteAt(5),
    });

    const feed = await attentionService(db).list(companyId, { userId: "board-user" });

    expect(failedRunIds(feed)).toContain(failedId);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, other.companyId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, other.companyId));
  });
});
