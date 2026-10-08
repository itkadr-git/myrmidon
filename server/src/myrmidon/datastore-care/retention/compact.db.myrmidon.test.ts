// server/src/myrmidon/datastore-care/retention/compact.db.myrmidon.test.ts
//
// myrmidon(1.6.5-DBC1): the compaction against an embedded Postgres — the
// acceptance behaviors of the part: terminal runs older than the window have
// the O1a keys removed and `_compactedAt` stamped, live runs and runs inside
// the window are untouched, the small keys survive, snapshots without any of
// the keys are not rewritten (idempotence), and the pass reports the
// compacted row count with the freed bytes.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  compactContextPass,
  CONTEXT_COMPACT_BATCH_SIZE,
  CONTEXT_COMPACTED_AT_KEY,
} from "./compact.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

describeEmbeddedPostgres("myrmidon(1.6.5-DBC1) context compaction in the database", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-dbc1-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: "COMA",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    ageDays: number;
    contextSnapshot?: Record<string, unknown> | null;
  }) {
    const runId = randomUUID();
    const createdAt = new Date(Date.now() - input.ageDays * DAY_MS);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status,
      contextSnapshot: input.contextSnapshot ?? undefined,
      createdAt,
      updatedAt: createdAt,
      finishedAt: input.status === "succeeded" ? createdAt : null,
    });
    return runId;
  }

  const heavySnapshot = (): Record<string, unknown> => ({
    taskKey: "OPE-1",
    issueId: "i-1",
    wakeReason: "assignment",
    executionContinuation: { messages: new Array(200).fill({ role: "user", content: "x".repeat(500) }) },
    paperclipTaskMarkdown: "task ".repeat(5000),
    paperclipWake: { payload: "p".repeat(4000) },
  });

  async function getSnapshot(runId: string): Promise<Record<string, unknown> | null> {
    const rows = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);
    return (rows[0]?.contextSnapshot as Record<string, unknown> | null) ?? null;
  }

  it("compacts terminal old runs, leaves live/recent/keyless rows untouched", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const oldTerminal = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 10, contextSnapshot: heavySnapshot() });
    const oldFailed = await seedRun({ companyId, agentId, status: "failed", ageDays: 8, contextSnapshot: heavySnapshot() });
    const liveOld = await seedRun({ companyId, agentId, status: "running", ageDays: 10, contextSnapshot: heavySnapshot() });
    const recentTerminal = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 2, contextSnapshot: heavySnapshot() });
    const keylessOld = await seedRun({ companyId, agentId, status: "cancelled", ageDays: 30, contextSnapshot: { taskKey: "OPE-2" } });
    const nullSnapshotOld = await seedRun({ companyId, agentId, status: "failed", ageDays: 30, contextSnapshot: null });

    const startedAt = new Date();
    const result = await compactContextPass(
      { db, sleep: async () => {} },
      {
        companyIds: [companyId],
        cutoff: new Date(startedAt.getTime() - 7 * DAY_MS).toISOString(),
        compactedAt: startedAt.toISOString(),
      },
    );

    expect(result.compacted).toBe(2);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(result.perCompany).toEqual([
      { companyId, compacted: 2, freedBytes: result.freedBytes },
    ]);

    for (const runId of [oldTerminal, oldFailed]) {
      const snapshot = await getSnapshot(runId);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.executionContinuation).toBeUndefined();
      expect(snapshot!.paperclipTaskMarkdown).toBeUndefined();
      expect(snapshot!.paperclipWake).toBeUndefined();
      expect(snapshot!._compactedAt).toBe(startedAt.toISOString());
      // small keys survive
      expect(snapshot!.taskKey).toBe("OPE-1");
      expect(snapshot!.issueId).toBe("i-1");
      expect(snapshot!.wakeReason).toBe("assignment");
    }

    // untouched rows keep their heavy payloads
    expect((await getSnapshot(liveOld))!.executionContinuation).toBeDefined();
    expect((await getSnapshot(recentTerminal))!.executionContinuation).toBeDefined();
    // the keyless old run keeps its snapshot byte-identical (no marker)
    const keyless = await getSnapshot(keylessOld);
    expect(keyless).toEqual({ taskKey: "OPE-2" });
    expect((await getSnapshot(nullSnapshotOld))).toBeNull();

    // idempotence: a second pass finds nothing to do
    const second = await compactContextPass(
      { db, sleep: async () => {} },
      {
        companyIds: [companyId],
        cutoff: new Date(Date.now() - 7 * DAY_MS).toISOString(),
        compactedAt: new Date().toISOString(),
      },
    );
    expect(second.compacted).toBe(0);
  });

  it("the batch selection uses the created_at window (rows newer than the cutoff are never touched)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    for (let i = 0; i < 3; i++) {
      await seedRun({ companyId, agentId, status: "succeeded", ageDays: 1, contextSnapshot: heavySnapshot() });
    }
    const result = await compactContextPass(
      { db, sleep: async () => {} },
      {
        companyIds: [companyId],
        cutoff: new Date(Date.now() - 7 * DAY_MS).toISOString(),
        compactedAt: new Date().toISOString(),
      },
    );
    expect(result.compacted).toBe(0);
    expect(result.freedBytes).toBe(0);
    // a wide-open cutoff compacts them
    const all = await compactContextPass(
      { db, sleep: async () => {} },
      {
        companyIds: [companyId],
        cutoff: new Date(Date.now() + DAY_MS).toISOString(),
        compactedAt: new Date().toISOString(),
      },
    );
    expect(all.compacted).toBe(3);
    expect(CONTEXT_COMPACT_BATCH_SIZE).toBe(500);
  });
});
