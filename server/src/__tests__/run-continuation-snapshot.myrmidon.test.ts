import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { getConversationOwnershipBlocker } from "../services/conversation-continuation.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";
import {
  EXECUTION_CONTINUATION_KEY,
  PAPERCLIP_WAKE_PAYLOAD_KEY,
  wakePayloadForDispatch,
  withoutDuplicateExecutionContinuation,
} from "../services/run-continuation-snapshot.js";

// myrmidon(RUN-SNAPSHOT-DEDUP): one stored copy of the execution continuation
// envelope per run. A run snapshot written before this change carries it twice
// (top level and inside `paperclipWake`); the run list and the run detail
// endpoint are the heavy readers this suite measures.

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const CONVERSATION_ADAPTER = "claude_local";
const MESSAGE_COUNT = 40;
const MESSAGE_BODY_CHARS = 2_000;
const RUNS_PER_SHAPE = 30;

/** A realistic continuation envelope: ~80 KB of messages. */
function continuationEnvelope(agentId: string, sequence: number) {
  return {
    version: 1,
    objective: `Continue task ${sequence} without repeating completed work.`,
    interruptedRunId: null,
    messages: Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
      id: randomUUID(),
      authorType: "user" as const,
      authorId: agentId,
      createdByRunId: null,
      body: `message ${index} `.padEnd(MESSAGE_BODY_CHARS, "x"),
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      updatedAt: new Date(1_700_000_000_000 + index).toISOString(),
      deleted: false,
      sourceTrust: null,
    })),
  };
}

function wakePayload(issueId: string) {
  return {
    reason: "issue_assigned",
    issue: {
      id: issueId,
      identifier: "DEDUP-1",
      title: "Measure the run snapshot",
      status: "in_progress",
      priority: "high",
      workMode: "standard",
    },
    comments: [],
  };
}

function snapshot(
  issueId: string,
  agentId: string,
  sequence: number,
  shape: "duplicated" | "single",
) {
  const continuation = continuationEnvelope(agentId, sequence);
  const wake = wakePayload(issueId);
  return {
    issueId,
    taskId: issueId,
    wakeReason: "issue_assigned",
    [EXECUTION_CONTINUATION_KEY]: continuation,
    [PAPERCLIP_WAKE_PAYLOAD_KEY]:
      shape === "duplicated"
        ? { ...wake, [EXECUTION_CONTINUATION_KEY]: continuation }
        : wake,
  };
}
function occurrences(text: string): number {
  return (text.match(/"executionContinuation"/g) ?? []).length;
}

async function timeIt<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await run();
  return { ms: performance.now() - started, value };
}

describePostgres("run continuation snapshot single copy", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let app: express.Express;
  let duplicated: { companyId: string; agentId: string; issueId: string; runId: string };
  let single: { companyId: string; agentId: string; issueId: string; runId: string };

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-run-continuation-snapshot-");
    db = createDb(temporary.connectionString);
    duplicated = await seedCompany("duplicated");
    single = await seedCompany("single");

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: `owner-${duplicated.companyId}`,
        source: "local_implicit",
        companyIds: [duplicated.companyId, single.companyId],
        memberships: [
          { companyId: duplicated.companyId, membershipRole: "owner", status: "active" },
          { companyId: single.companyId, membershipRole: "owner", status: "active" },
        ],
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
  }, 90_000);

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function seedCompany(shape: "duplicated" | "single") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Snapshot ${shape}`,
      issuePrefix: `S${companyId.slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Snapshot agent ${shape}`,
      role: "engineer" as const,
      status: "active" as const,
      adapterType: CONVERSATION_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Heavy run snapshot ${shape}`,
      status: "in_progress",
    });
    const rows = await db
      .insert(heartbeatRuns)
      .values(
        Array.from({ length: RUNS_PER_SHAPE }, (_, index) => ({
          companyId,
          agentId,
          status: "failed",
          runtimeMode: "legacy",
          runnerProfileJson: { adapterDispatch: { adapterType: CONVERSATION_ADAPTER } },
          processPid: 900_000 + index,
          processStartedAt: new Date(1_700_000_000_000 + index),
          contextSnapshot: snapshot(issueId, agentId, index, shape),
        })),
      )
      .returning({ id: heartbeatRuns.id });
    return { companyId, agentId, issueId, runId: rows[0]!.id };
  }

  it("writes the wake payload without a second copy of the continuation", async () => {
    const context: Record<string, unknown> = {
      issueId: duplicated.issueId,
      taskId: duplicated.issueId,
      wakeReason: "issue_assigned",
      [EXECUTION_CONTINUATION_KEY]: continuationEnvelope(duplicated.agentId, 99),
    };
    const payload = await buildPaperclipWakePayload({
      db,
      companyId: duplicated.companyId,
      agentId: duplicated.agentId,
      runId: duplicated.runId,
      contextSnapshot: context,
    });
    expect(payload).not.toBeNull();
    expect(occurrences(JSON.stringify(payload))).toBe(0);

    // This is the shape the server persists for the run.
    context[PAPERCLIP_WAKE_PAYLOAD_KEY] = payload;
    expect(occurrences(JSON.stringify(context))).toBe(1);

    // …and the adapter still receives the envelope, attached at dispatch only.
    const dispatched = wakePayloadForDispatch(context) as Record<string, unknown>;
    expect(occurrences(JSON.stringify(dispatched))).toBe(1);
    expect(dispatched[EXECUTION_CONTINUATION_KEY]).toEqual(
      context[EXECUTION_CONTINUATION_KEY],
    );
  });

  it("never delivers a nested copy the run does not own", () => {
    const stale = snapshot(duplicated.issueId, duplicated.agentId, 3, "duplicated");
    const dispatched = wakePayloadForDispatch({
      ...stale,
      [EXECUTION_CONTINUATION_KEY]: null,
    }) as Record<string, unknown>;
    expect(dispatched).not.toHaveProperty(EXECUTION_CONTINUATION_KEY);

    // A snapshot without a wake payload is handed over untouched.
    expect(wakePayloadForDispatch({ issueId: duplicated.issueId })).toBeUndefined();
    const untouched = { [PAPERCLIP_WAKE_PAYLOAD_KEY]: wakePayload(duplicated.issueId) };
    expect(wakePayloadForDispatch(untouched)).toBe(untouched[PAPERCLIP_WAKE_PAYLOAD_KEY]);
  });

  it("drops only a byte-identical nested duplicate from a response snapshot", () => {
    const withDuplicate = snapshot(duplicated.issueId, duplicated.agentId, 4, "duplicated");
    const projected = withoutDuplicateExecutionContinuation(withDuplicate);
    expect(occurrences(JSON.stringify(projected))).toBe(1);
    expect(projected[EXECUTION_CONTINUATION_KEY]).toEqual(
      withDuplicate[EXECUTION_CONTINUATION_KEY],
    );

    const differing = {
      ...withDuplicate,
      [PAPERCLIP_WAKE_PAYLOAD_KEY]: {
        ...wakePayload(duplicated.issueId),
        [EXECUTION_CONTINUATION_KEY]: { version: 1, objective: "other", messages: [] },
      },
    };
    expect(withoutDuplicateExecutionContinuation(differing)).toBe(differing);
    const noCanonical = { ...withDuplicate, [EXECUTION_CONTINUATION_KEY]: null };
    expect(withoutDuplicateExecutionContinuation(noCanonical)).toBe(noCanonical);
  });

  async function storedSnapshot(runId: string) {
    const [row] = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        bytes: sql<number>`octet_length(${heartbeatRuns.contextSnapshot}::text)::int`,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return {
      contextSnapshot: row?.contextSnapshot ?? {},
      bytes: Number(row?.bytes ?? 0),
    };
  }

  async function measureDetail(target: { runId: string }) {
    const started = performance.now();
    const response = await request(app).get(`/api/heartbeat-runs/${target.runId}`);
    const ms = performance.now() - started;
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const text = JSON.stringify(response.body);
    // The response carries the envelope once, whatever shape the row was
    // written in.
    expect(occurrences(text)).toBe(1);
    const after = Buffer.byteLength(text);
    const stored = await storedSnapshot(target.runId);
    const before = Buffer.byteLength(
      JSON.stringify({ ...response.body, contextSnapshot: stored.contextSnapshot }),
    );
    return { ms, before, after, stored };
  }

  async function measureList(target: { companyId: string }) {
    const attempts: Array<{ ms: number; bytes: number }> = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now();
      const response = await request(app).get(
        `/api/companies/${target.companyId}/heartbeat-runs?limit=50`,
      );
      attempts.push({
        ms: performance.now() - started,
        bytes: Buffer.byteLength(JSON.stringify(response.body)),
      });
      expect(response.status).toBe(200);
      if (attempt === 0) expect(response.body).toHaveLength(RUNS_PER_SHAPE);
    }
    return attempts;
  }

  it("measures the run detail endpoint on both snapshot shapes", async () => {
    const legacy = await measureDetail(duplicated);
    const current = await measureDetail(single);
    expect(legacy.after).toBeLessThan(legacy.before);
    expect(Math.abs(current.after - legacy.after)).toBeLessThan(current.after * 0.02);
    expect(current.stored.bytes).toBeLessThan(legacy.stored.bytes / 1.5);

    console.log(
      [
        "=== RUN-SNAPSHOT-DEDUP: run detail endpoint (GET /api/heartbeat-runs/:id) ===",
        `stored snapshot, duplicated shape: ${legacy.stored.bytes} bytes`,
        `stored snapshot, single-copy shape: ${current.stored.bytes} bytes`,
        `response with the duplicated snapshot: ${legacy.before} bytes in ${legacy.ms.toFixed(1)} ms`,
        `response after the single-copy projection: ${legacy.after} bytes in ${legacy.ms.toFixed(1)} ms`,
        `response, newly written single-copy run: ${current.after} bytes in ${current.ms.toFixed(1)} ms`,
      ].join("\n"),
    );
  });

  it("measures the run list endpoint on both snapshot shapes", async () => {
    const legacyAttempts = await measureList(duplicated);
    const currentAttempts = await measureList(single);
    const best = (attempts: Array<{ ms: number }>) =>
      Math.min(...attempts.map((attempt) => attempt.ms));

    console.log(
      [
        `=== RUN-SNAPSHOT-DEDUP: run list endpoint (GET /api/companies/:id/heartbeat-runs?limit=50), ${RUNS_PER_SHAPE} runs ===`,
        `duplicated-shape rows: ${best(legacyAttempts).toFixed(1)} ms (best of 3), response ${legacyAttempts[0]!.bytes} bytes`,
        `single-copy rows: ${best(currentAttempts).toFixed(1)} ms (best of 3), response ${currentAttempts[0]!.bytes} bytes`,
      ].join("\n"),
    );
  });

  it("measures the ownership probe read shape", async () => {
    const predicate = and(
      eq(heartbeatRuns.companyId, duplicated.companyId),
      eq(heartbeatRuns.runtimeMode, "legacy"),
      sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType' = ${CONVERSATION_ADAPTER}`,
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${duplicated.issueId}`,
      inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
      or(isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId)),
    );
    const heavy = await db.select({ bytes: sql<number>`octet_length(${heartbeatRuns.contextSnapshot}::text)::int` }).from(heartbeatRuns).where(predicate);
    const heavyBytes = heavy.reduce((total, row) => total + Number(row.bytes ?? 0), 0);
    expect(heavyBytes).toBeGreaterThan(1_000_000);

    const before = await timeIt(() => db.select({ run: heartbeatRuns }).from(heartbeatRuns).where(predicate));
    const after = await timeIt(() =>
      db.select({ runId: heartbeatRuns.id, processPid: heartbeatRuns.processPid }).from(heartbeatRuns).where(predicate),
    );
    const probe = await timeIt(() => getConversationOwnershipBlocker(db, duplicated.companyId, duplicated.issueId));
    expect(probe.value).toBeNull();
    expect(after.value).toHaveLength(before.value.length);

    console.log(
      [
        `=== RUN-SNAPSHOT-DEDUP: run-ownership probe, ${before.value.length} candidate runs ===`,
        `full-row select (before): ${before.ms.toFixed(1)} ms, snapshot bytes drawn: ${heavyBytes}`,
        `narrow select (after): ${after.ms.toFixed(1)} ms, snapshot bytes drawn: 0`,
        `getConversationOwnershipBlocker (shipped code): ${probe.ms.toFixed(1)} ms`,
      ].join("\n"),
    );
  });
});
