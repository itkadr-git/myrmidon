import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunContinuations, heartbeatRuns } from "@myrmidon/db";
import type { ExecutionContinuationEnvelope } from "@myrmidon/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  EXECUTION_CONTINUATION_KEY,
  loadRunContinuationEnvelope,
  persistRunContinuation,
  runContextForPersistence,
} from "./run-continuation-snapshot.js";

// myrmidon(DB-CARE DBC-3): the execution continuation envelope lives in
// heartbeat_run_continuations, one row per run, and leaves context_snapshot.
// Readers keep a fallback for the rows written before this change.

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("heartbeat run continuations (DBC-3)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  const envelope = (objective: string): ExecutionContinuationEnvelope => ({
    version: 1,
    companyId,
    issueId: randomUUID(),
    trigger: { reason: "issue_assigned", interactionId: null, sourceRunId: null },
    originCommentIds: [],
    objective,
    messages: [],
    interactionOutcomes: [],
    completedWork: null,
    unresolvedInteractionIds: [],
    coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
  });

  const createRun = async (contextSnapshot: Record<string, unknown>) => {
    const [row] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "failed", runtimeMode: "legacy", contextSnapshot })
      .returning({ id: heartbeatRuns.id });
    return row!.id;
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-continuations-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "company-dbc3", issuePrefix: "DBC" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-dbc3",
      role: "engineer",
      adapterType: "paperclip_runner",
    });
  }, 90_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it("drops the envelope from the snapshot bound for the database", () => {
    const context = {
      issueId: randomUUID(),
      wakeReason: "issue_assigned",
      [EXECUTION_CONTINUATION_KEY]: envelope("keep the column small"),
      paperclipWake: { reason: "issue_assigned" },
    };
    const persisted = runContextForPersistence(context);

    expect(persisted).not.toHaveProperty(EXECUTION_CONTINUATION_KEY);
    expect(persisted.paperclipWake).toEqual({ reason: "issue_assigned" });
    expect(persisted.issueId).toBe(context.issueId);
    // The in-memory context, used by dispatch and the prompt, keeps the envelope.
    expect(context[EXECUTION_CONTINUATION_KEY]).toBeDefined();
    // A snapshot without the key is handed back untouched.
    const plain = { issueId: context.issueId };
    expect(runContextForPersistence(plain)).toBe(plain);
  });

  it("stores one row per run and reads it back", async () => {
    const runId = await createRun({ issueId: randomUUID() });
    const stored = envelope("first objective");

    expect(
      await persistRunContinuation(db, {
        companyId,
        agentId,
        issueId: null,
        runId,
        previousContextRunId: null,
        envelope: stored,
        wakeLinks: { runId, originCommentIds: [], sourceRunId: null, interactionId: null },
      }),
    ).toBe(true);

    const loaded = await loadRunContinuationEnvelope(db, { companyId, runId });
    expect(loaded?.objective).toBe("first objective");

    // A second write for the same run replaces the row instead of duplicating it.
    expect(
      await persistRunContinuation(db, {
        companyId,
        agentId,
        issueId: null,
        runId,
        previousContextRunId: null,
        envelope: envelope("second objective"),
      }),
    ).toBe(true);
    const updated = await loadRunContinuationEnvelope(db, { companyId, runId });
    expect(updated?.objective).toBe("second objective");
  });

  // myrmidon(DB-SIZE OPE-12581): the stored row keeps message identity and
  // freshness as references (`bodyOmitted`), because bodies live in
  // issue_comments and the resume delta re-reads the thread at dispatch. The
  // byte-heavy fields nobody reads from the stored row (completedWork,
  // interaction outcomes, resume delta copies) do not travel to the database.
  it("stores the envelope as body references instead of full bodies", async () => {
    const runId = await createRun({ issueId: randomUUID() });
    const now = new Date().toISOString();
    const full: ExecutionContinuationEnvelope = {
      ...envelope("compact storage"),
      originCommentIds: [],
      objective: "compact storage",
      messages: [
        {
          id: randomUUID(),
          authorType: "user",
          authorId: null,
          createdByRunId: null,
          body: "x".repeat(8_000),
          createdAt: now,
          updatedAt: now,
          deleted: false,
          sourceTrust: null,
        },
        {
          id: randomUUID(),
          authorType: "agent",
          authorId: agentId,
          createdByRunId: runId,
          body: "y".repeat(8_000),
          createdAt: now,
          updatedAt: now,
          deleted: false,
          sourceTrust: null,
        },
      ],
      interactionOutcomes: [
        { id: randomUUID(), kind: "ask_user_questions", status: "answered", result: { answer: "z".repeat(4_000) } },
      ],
      completedWork: "w".repeat(16_000),
      completedActions: [
        {
          runId,
          receiptId: randomUUID(),
          operationId: "update_issue",
          result: { ok: true, payload: "q".repeat(4_000) },
        },
      ],
      unresolvedInteractionIds: [],
      coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
    };

    expect(
      await persistRunContinuation(db, {
        companyId,
        agentId,
        issueId: null,
        runId,
        previousContextRunId: null,
        envelope: full,
      }),
    ).toBe(true);

    const [row] = await db
      .select({ envelope: heartbeatRunContinuations.envelope, chars: heartbeatRunContinuations.envelopeChars })
      .from(heartbeatRunContinuations)
      .where(eq(heartbeatRunContinuations.runId, runId));
    const storedEnvelope = row?.envelope;
    expect(storedEnvelope).toBeDefined();
    // Bodies are references now; identity and freshness stay.
    expect(storedEnvelope?.messages).toHaveLength(2);
    for (const message of storedEnvelope?.messages ?? []) {
      expect(message.body).toBe("");
      expect(message.bodyOmitted).toBe(true);
      expect(message.updatedAt).toBe(now);
    }
    // Nobody reads these from the stored row; they are rebuilt from source tables.
    expect(storedEnvelope?.completedWork).toBeNull();
    expect(storedEnvelope?.interactionOutcomes).toEqual([]);
    expect(storedEnvelope?.completedActions).toBeUndefined();
    expect(storedEnvelope?.resumeDelta).toBeUndefined();
    expect(row?.chars ?? 0).toBeLessThan(2_000);
  });

  it("falls back to the legacy snapshot copy and then to nothing", async () => {
    const legacy = envelope("legacy snapshot objective");
    const legacyRunId = await createRun({ issueId: randomUUID(), [EXECUTION_CONTINUATION_KEY]: legacy });

    const fromSnapshot = await loadRunContinuationEnvelope(db, {
      companyId,
      runId: legacyRunId,
      legacyContext: { issueId: randomUUID(), [EXECUTION_CONTINUATION_KEY]: legacy },
    });
    expect(fromSnapshot?.objective).toBe("legacy snapshot objective");

    const emptyRunId = await createRun({ issueId: randomUUID() });
    expect(await loadRunContinuationEnvelope(db, { companyId, runId: emptyRunId })).toBeNull();
  });

  it("applies the compact migration 0476 to historical full-envelope rows", async () => {
    const runId = await createRun({ issueId: randomUUID() });
    const now = new Date().toISOString();
    const historicalEnvelope: ExecutionContinuationEnvelope = {
      ...envelope("historical objective"),
      originCommentIds: [],
      objective: "historical objective",
      messages: [
        {
          id: randomUUID(),
          authorType: "user",
          authorId: null,
          createdByRunId: null,
          body: "historic message body ".repeat(500),
          createdAt: now,
          updatedAt: now,
          deleted: false,
          sourceTrust: null,
        },
      ],
      interactionOutcomes: [
        { id: randomUUID(), kind: "ask_user_questions", status: "answered", result: { answer: "data" } },
      ],
      completedWork: "prior work summary ".repeat(500),
      completedActions: [
        {
          runId,
          receiptId: randomUUID(),
          operationId: "write",
          result: { ok: true },
        },
      ],
      unresolvedInteractionIds: [],
      coverage: { kind: "full_task_history", throughCommentId: null, summaryThroughCommentId: null },
    };

    // Insert raw historical row directly without the compaction writer
    await db.insert(heartbeatRunContinuations).values({
      companyId,
      agentId,
      issueId: null,
      runId,
      previousContextRunId: null,
      envelope: historicalEnvelope,
      envelopeChars: JSON.stringify(historicalEnvelope).length,
    });

    const migrationSql = readFileSync(
      new URL("../../../packages/db/src/migrations/0476_compact_heartbeat_run_continuations.sql", import.meta.url),
      "utf8",
    );
    // Execute migration
    await db.execute(sql.raw(migrationSql));

    const [migratedRow] = await db
      .select({ envelope: heartbeatRunContinuations.envelope, chars: heartbeatRunContinuations.envelopeChars })
      .from(heartbeatRunContinuations)
      .where(eq(heartbeatRunContinuations.runId, runId));

    expect(migratedRow?.envelope?.messages[0]?.body).toBe("");
    expect(migratedRow?.envelope?.messages[0]?.bodyOmitted).toBe(true);
    expect(migratedRow?.envelope?.completedWork).toBeNull();
    expect(migratedRow?.chars).toBeLessThan(1_500);

    // Migration must be idempotent on re-execution
    await db.execute(sql.raw(migrationSql));
  });
});