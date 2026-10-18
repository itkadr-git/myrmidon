import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
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
});