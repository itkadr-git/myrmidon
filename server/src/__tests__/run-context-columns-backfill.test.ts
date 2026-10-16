// OPE-5007 П2: the thin context_* columns are filled by a batched background
// job, not by the migration transaction.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { backfillRunContextColumns } from "../services/run-context-columns-backfill.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("run context columns backfill job", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-context-backfill-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Backfill Co",
      issuePrefix: "BFL",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Backfiller",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("fills historical rows in several batches, skips filled and empty rows, and is idempotent", async () => {
    const issueId = randomUUID();
    const oldIds = Array.from({ length: 5 }, () => randomUUID());
    for (const [index, id] of oldIds.entries()) {
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: {
          issueId,
          taskId: `task-${index}`,
          taskKey: `BFL-${index}`,
          wakeReason: "issue_commented",
          taskTitle: `Title ${index}`,
          executionContinuation: { objective: "ignored: taskTitle wins" },
        },
      });
    }
    const emptyId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: emptyId, companyId, agentId, status: "queued", contextSnapshot: null });
    const filledId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: filledId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId: "from-snapshot" },
      contextIssueId: "already-filled",
    });
    const objectiveOnlyId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: objectiveOnlyId,
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { executionContinuation: { objective: "finish it" } },
    });

    const pauses: number[] = [];
    const result = await backfillRunContextColumns(db as any, {
      batchSize: 2,
      pauseMs: 7,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(result.scanned).toBe(8);
    expect(result.batches).toBe(4);
    expect(result.updated).toBe(6);
    // The job yields between batches instead of running one long statement.
    expect(pauses.length).toBeGreaterThanOrEqual(3);
    expect(pauses.every((ms) => ms === 7)).toBe(true);

    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [index, id] of oldIds.entries()) {
      expect(byId.get(id)).toMatchObject({
        contextIssueId: issueId,
        contextTaskId: `task-${index}`,
        contextTaskKey: `BFL-${index}`,
        contextWakeReason: "issue_commented",
        contextRunSummary: `Title ${index}`,
      });
      // The snapshot itself is untouched, executionContinuation included.
      expect(byId.get(id)?.contextSnapshot).toHaveProperty("executionContinuation");
    }
    expect(byId.get(emptyId)?.contextIssueId).toBeNull();
    expect(byId.get(filledId)?.contextIssueId).toBe("already-filled");
    expect(byId.get(objectiveOnlyId)?.contextRunSummary).toBe("finish it");

    const again = await backfillRunContextColumns(db as any, { batchSize: 2, pauseMs: 0 });
    expect(again.updated).toBe(0);
  }, 60_000);

  it("commits each batch on its own: an abort after the first batch keeps its rows", async () => {
    const ids = Array.from({ length: 4 }, () => randomUUID());
    for (const id of ids) {
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId: `issue-${id}` },
      });
    }
    const controller = new AbortController();
    const result = await backfillRunContextColumns(db as any, {
      batchSize: 2,
      pauseMs: 1,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });
    expect(result.batches).toBe(1);
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(rows.filter((row) => row.contextIssueId !== null)).toHaveLength(2);
  }, 60_000);
});
