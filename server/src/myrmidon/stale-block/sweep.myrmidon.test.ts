// myrmidon(STALE-BLOCK): sweep behavior against an embedded Postgres. The four
// switch cases the ticket names: a closed (done) blocker, a cancelled blocker,
// a past due date — all unblocked — and a live blocker, left untouched.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueRelations,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createStaleBlockSweep, type StaleBlockSweepDeps } from "./sweep.js";
import { toBlockedLoopEvent } from "../blocked-loop/history.js";
import { readStaleBlockSignals, resetStaleBlockSignals } from "./attention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-03T12:00:00.000Z");

describeEmbeddedPostgres("stale block sweep", () => {
  // myrmidon(STALE-BLOCK): the unblock path goes through the full issue update
  // service with embedded PostgreSQL; under a loaded CI box 15 s is not
  // enough, so this suite uses the same headroom as run-stall's.
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-stale-block-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    resetStaleBlockSignals();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * One blocked task with one blocker task of the given status, or with a
   * reasonRef instead of a blocked-by edge. Neutral English fixtures only.
   */
  async function seed(input: {
    blockerStatus?: string;
    withRelation?: boolean;
    unblockDescriptor?: Record<string, unknown> | null;
    updatedAt?: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `SB${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      title: "Task a",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      unblockDescriptor: (input.unblockDescriptor ?? {
        owner: { agentId },
        action: "finish the blocker first",
      }) as any,
      blockedTransitionAt: new Date("2026-09-30T08:00:00.000Z"),
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    });
    if (input.blockerStatus !== undefined) {
      await db.insert(issues).values({
        id: blockerIssueId,
        companyId,
        identifier: `BL${blockerIssueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        title: "Blocker a",
        status: input.blockerStatus,
        priority: "medium",
      });
    }
    if (input.withRelation && input.blockerStatus !== undefined) {
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      });
    }
    return { companyId, agentId, issueId, blockerIssueId };
  }

  function deps(overrides: Partial<StaleBlockSweepDeps> = {}): StaleBlockSweepDeps {
    return {
      db,
      isEventStillSet: vi.fn(async () => true),
      logActivity: vi.fn(async () => undefined),
      env: { MYRMIDON_STALE_BLOCK_ENABLED: "1", MYRMIDON_STALE_BLOCK_INTERVAL_SEC: "0" } as NodeJS.ProcessEnv,
      now: () => NOW,
      ...overrides,
    };
  }

  function sweepWith(overrides: Partial<StaleBlockSweepDeps> = {}) {
    const injected = deps(overrides);
    return { injected, sweep: createStaleBlockSweep(injected) };
  }

  it("is off by default and the pass is skipped", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const injected = deps({ env: {} as NodeJS.ProcessEnv });
    const sweep = createStaleBlockSweep(injected);
    const result = await sweep.sweep();
    expect(result.skippedPass).toBe(true);
    expect(result.scanned).toBe(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("blocked");
  });

  it("unblocks a task whose blocker is done: edge removed, in_progress, system comment", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const { sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, unblocked: 1, skippedLive: 0, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    expect(issue!.unblockDescriptor).toBeNull();

    const relations = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, seeded.companyId), eq(issueRelations.relatedIssueId, seeded.issueId)));
    expect(relations).toHaveLength(0);

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.body).toContain("the blocking task is done");
    expect(comments[0]!.body).toContain("in_progress");
  });

  it("unblocks a task whose blocker is cancelled (the silent dead block)", async () => {
    const seeded = await seed({ blockerStatus: "cancelled", withRelation: true });
    const { sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, unblocked: 1, skippedLive: 0, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("the blocking task is cancelled");
  });

  it("unblocks a task whose reasonRef due date passed", async () => {
    const seeded = await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait until the freeze ends",
        reasonRef: { kind: "date", dueAt: "2026-10-01T00:00:00.000Z" },
      },
    });
    const { sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, unblocked: 1, skippedLive: 0, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("the due date passed");
  });

  it("leaves a live blocker completely untouched", async () => {
    const seeded = await seed({ blockerStatus: "in_progress", withRelation: true });
    const { injected, sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, unblocked: 0, skippedLive: 1, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("blocked");
    const relations = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, seeded.companyId), eq(issueRelations.relatedIssueId, seeded.issueId)));
    expect(relations).toHaveLength(1);
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(0);
    expect(injected.logActivity).not.toHaveBeenCalled();
  });

  it("leaves a future due date and a still-set event alone", async () => {
    await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait",
        reasonRef: { kind: "date", dueAt: "2026-10-05T00:00:00.000Z" },
      },
    });
    await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait for the gate",
        reasonRef: { kind: "event", eventKey: "release-gate" },
      },
    });
    const { sweep } = sweepWith();
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 2, unblocked: 0, skippedLive: 2, failed: 0 });
  });

  // myrmidon(BLOCKER-WAKE-LOOP-B): an event reason with a passed deadline is
  // dead even while the gate seam still answers "set" (an unwired gate would
  // otherwise hold the task forever).
  it("unblocks an event reason whose deadline passed while the gate is still set", async () => {
    const seeded = await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait for the tag",
        reasonRef: { kind: "event", eventKey: "release-1.6", dueAt: "2026-10-01T00:00:00.000Z" },
      },
    });
    const { sweep } = sweepWith();
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 1, unblocked: 1, skippedLive: 0, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments[0]!.body).toContain("the event deadline passed");
  });

  it("leaves an event reason with a future deadline alone", async () => {
    await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait for the tag",
        reasonRef: { kind: "event", eventKey: "release-1.6", dueAt: "2026-10-05T00:00:00.000Z" },
      },
    });
    const { sweep } = sweepWith();
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 1, unblocked: 0, skippedLive: 1, failed: 0 });
  });

  it("unblocks an event reason once the gate is cleared, through the injected seam", async () => {
    const seeded = await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait for the gate",
        reasonRef: { kind: "event", eventKey: "release-gate" },
      },
    });
    const { sweep } = sweepWith({ isEventStillSet: vi.fn(async () => false) });
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 1, unblocked: 1 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments[0]!.body).toContain("the gate or event no longer applies");
  });

  it("a task with one live and one dead reason stays blocked (only dead edges would go)", async () => {
    // reasonRef of kind date is live (future); the fallback edges are not read
    // when reasonRef exists, so the task keeps its live reason and stays.
    const seeded = await seed({
      blockerStatus: "in_progress",
      withRelation: true,
      unblockDescriptor: {
        owner: "board",
        action: "wait",
        reasonRef: { kind: "date", dueAt: "2026-10-05T00:00:00.000Z" },
      },
    });
    const { sweep } = sweepWith();
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 1, unblocked: 0, skippedLive: 1 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("blocked");
  });

  it("T4: unblocks a blocked task with no reasons (reasons.length === 0) to todo without assignee", async () => {
    const seeded = await seed({
      blockerStatus: undefined,
      unblockDescriptor: { owner: "board", action: "waiting" },
    });
    const { sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, unblocked: 1, skippedLive: 0, skippedUnknown: 0, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("todo");
    expect(issue!.assigneeAgentId).toBeNull();
    expect(issue!.unblockDescriptor).toBeNull();

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.body).toContain("todo");
    expect(comments[0]!.body).toContain("without assignee");

    const signals = readStaleBlockSignals(seeded.companyId, NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      issueId: seeded.issueId,
      targetStatus: "todo",
      reasonTexts: ["blocked without a reason"],
      liftedAt: NOW.toISOString(),
    });
  });

  it("P1: a bare block behind a full page of live blocks is still reached in one pass", async () => {
    // 50 old live blocks fill the page (page size 50); the bare block is the
    // newest row, so without the reserved slot it would never be scanned and
    // the T4 backfill would starve. The sweep must include it anyway.
    const OLD = new Date("2026-09-20T08:00:00.000Z");
    for (let i = 0; i < 50; i++) {
      await seed({
        blockerStatus: undefined,
        unblockDescriptor: {
          owner: "board",
          action: "wait",
          reasonRef: { kind: "date", dueAt: "2026-10-10T00:00:00.000Z" },
        },
        updatedAt: OLD,
      });
    }
    const bare = await seed({
      blockerStatus: undefined,
      unblockDescriptor: { owner: "board", action: "waiting" },
      updatedAt: new Date("2026-10-02T08:00:00.000Z"),
    });
    const { sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result.scanned).toBe(50);
    expect(result.unblocked).toBe(1);
    expect(result).toMatchObject({ skippedLive: 49, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, bare.issueId));
    expect(issue!.status).toBe("todo");
    expect(issue!.assigneeAgentId).toBeNull();
  });

  it("T6: leaves a blocked task with a valid live reasonRef alone in blocked", async () => {
    const seeded = await seed({
      blockerStatus: undefined,
      unblockDescriptor: {
        owner: "board",
        action: "wait until future date",
        reasonRef: { kind: "date", dueAt: "2026-10-10T00:00:00.000Z" },
      },
    });
    const { sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, unblocked: 0, skippedLive: 1, failed: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("blocked");
    expect(issue!.assigneeAgentId).toBe(seeded.agentId);
    expect(issue!.unblockDescriptor).not.toBeNull();

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.issueId));
    expect(comments).toHaveLength(0);
  });

  it("writes the activity log rows for an unblock: marker plus issue.updated for BLOCKED-LOOP", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const { injected, sweep } = sweepWith();
    await sweep.sweep();
    expect(injected.logActivity).toHaveBeenCalledTimes(2);
    expect((injected.logActivity as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "stale_block_sweep",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issueId,
    });
    expect((injected.logActivity as ReturnType<typeof vi.fn>).mock.calls[0]![0].details).toMatchObject({
      changes: { status: { from: "blocked", to: "in_progress" } },
    });
    expect((injected.logActivity as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toMatchObject({
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "stale_block_sweep",
      action: "myrmidon.stale_block.unblocked",
      entityType: "issue",
      entityId: seeded.issueId,
    });
  });

  it("OPE-9074: activity rows are written through the unblock transaction, never the root handle", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    // The sweep holds the issue row FOR UPDATE; the activity_log trigger
    // touches that same issue row, so a write through the root handle would
    // queue behind the sweep's own transaction (idle in transaction, a
    // self-deadlock). The injected writer inserts through whatever handle it
    // is given, exactly like the real one.
    const seenHandles: unknown[] = [];
    const { sweep } = sweepWith({
      logActivity: async (entry, dbOrTx) => {
        seenHandles.push(dbOrTx);
        const handle = (dbOrTx ?? db) as typeof db;
        await handle.execute(sql`set local lock_timeout = '3s'`).catch(() => undefined);
        await handle.insert(activityLog).values({
          companyId: entry.companyId,
          actorType: entry.actorType,
          actorId: entry.actorId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          details: entry.details,
        });
      },
    });

    const result = await sweep.sweep();

    expect(result).toMatchObject({ unblocked: 1, failed: 0 });
    expect(seenHandles).toHaveLength(2);
    for (const handle of seenHandles) {
      expect(handle).toBeDefined();
      expect(handle).not.toBe(db);
    }
    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, seeded.issueId));
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "myrmidon.stale_block.unblocked"]),
    );
  });

  it("OPE-9078: live events are queued for after commit, not published inline", async () => {
    await seed({ blockerStatus: "done", withRelation: true });
    const queued: unknown[][] = [];
    const { sweep } = sweepWith({
      logActivity: vi.fn(async (_entry, _dbOrTx, postCommitPublications) => {
        queued.push(postCommitPublications as unknown[]);
      }),
    });
    const result = await sweep.sweep();
    expect(result).toMatchObject({ unblocked: 1, failed: 0 });
    expect(queued).toHaveLength(2);
    for (const list of queued) expect(Array.isArray(list)).toBe(true);
    // Both calls share one deferred-publication list (published after commit).
    expect(queued[0]).toBe(queued[1]);
  });

  it("P2: the sweep-written issue.updated row parses as a left_blocked event for BLOCKED-LOOP", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const { injected, sweep } = sweepWith();
    await sweep.sweep();
    const transitionCall = (injected.logActivity as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => (call[0] as { action: string }).action === "issue.updated",
    );
    expect(transitionCall).toBeDefined();
    const event = toBlockedLoopEvent({
      createdAt: NOW,
      actorType: "system",
      details: (transitionCall![0] as { details: unknown }).details,
    });
    expect(event).toMatchObject({ kind: "left_blocked" });
    expect(event!.blockerSetKey).toBeNull();
  });

  it("records the operator signal for the attention feed after an unblock", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const { sweep } = sweepWith();
    await sweep.sweep();
    const signals = readStaleBlockSignals(seeded.companyId, NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      issueId: seeded.issueId,
      identifier: expect.any(String),
      reasonTexts: ["the blocking task is done"],
      liftedAt: NOW.toISOString(),
    });
  });

  it("is idempotent: a second pass finds the task no longer blocked", async () => {
    const seeded = await seed({ blockerStatus: "done", withRelation: true });
    const { sweep } = sweepWith();
    await sweep.sweep();
    const commentsAfterFirst = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    const second = await sweep.sweep();
    expect(second).toMatchObject({ scanned: 0, unblocked: 0 });
    const commentsAfterSecond = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(commentsAfterSecond).toHaveLength(commentsAfterFirst.length);
  });

  it("fair traversal: 120 blocked tasks (50 old live + 70 expired dueAt) are all unblocked across 3 passes", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fair Traverse Co" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent A",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const rowsToInsert = [];
    // 50 older live blocks (e.g. updatedAt 2026-10-01, live event reason)
    for (let i = 0; i < 50; i++) {
      rowsToInsert.push({
        id: randomUUID(),
        companyId,
        identifier: `LIVE-${String(i).padStart(3, "0")}`,
        title: `Live task ${i}`,
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        unblockDescriptor: {
          owner: { agentId },
          action: "wait for external signal",
          reasonRef: { kind: "event", eventKey: "custom:live", dueAt: "2026-10-04T12:00:00.000Z" },
        },
        blockedTransitionAt: new Date("2026-10-01T08:00:00.000Z"),
        updatedAt: new Date(`2026-10-01T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`),
      });
    }

    // 70 newer dead blocks (e.g. updatedAt 2026-10-02, dueAt expired relative to NOW)
    for (let i = 0; i < 70; i++) {
      rowsToInsert.push({
        id: randomUUID(),
        companyId,
        identifier: `DEAD-${String(i).padStart(3, "0")}`,
        title: `Dead task ${i}`,
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        unblockDescriptor: {
          owner: { agentId },
          action: "wait for external service",
          reasonRef: {
            kind: "event",
            eventKey: "github:inst:1",
            dueAt: "2026-10-02T12:00:00.000Z", // Expired relative to NOW (2026-10-03T12:00:00.000Z)
          },
        },
        blockedTransitionAt: new Date("2026-10-02T08:00:00.000Z"),
        updatedAt: new Date(`2026-10-02T08:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`),
      });
    }

    await db.insert(issues).values(rowsToInsert as any);

    // sweep with isEventStillSet returning true for custom:live
    const { sweep } = sweepWith({
      isEventStillSet: vi.fn(async (_companyId, key) => key === "custom:live"),
    });

    // Pass 1: checks the 50 oldest (all live)
    const pass1 = await sweep.sweep({ force: true, at: NOW });
    expect(pass1.scanned).toBe(50);
    expect(pass1.unblocked).toBe(0);
    expect(pass1.skippedLive).toBe(50);

    // Pass 2: continues with keyset cursor to next 50 (50 dead)
    const pass2 = await sweep.sweep({ force: true, at: NOW });
    expect(pass2.scanned).toBe(50);
    expect(pass2.unblocked).toBe(50);
    expect(pass2.skippedLive).toBe(0);

    // Pass 3: continues with keyset cursor to next 20 (20 dead)
    const pass3 = await sweep.sweep({ force: true, at: NOW });
    expect(pass3.scanned).toBe(20);
    expect(pass3.unblocked).toBe(20);
    expect(pass3.skippedLive).toBe(0);

    // Across 3 passes, all 70 dead blocks are unblocked!
    expect(pass1.unblocked + pass2.unblocked + pass3.unblocked).toBe(70);

    const remainingBlocked = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked")));
    expect(remainingBlocked).toHaveLength(50);
    expect(remainingBlocked.every((r) => r.identifier?.startsWith("LIVE-"))).toBe(true);
  });

  it("tracks oldest unswept blocked task age and raises starvation alert if > 1 hour", async () => {
    // Task was blocked 2 hours before NOW and has not been swept yet
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    await seed({
      blockerStatus: "in_progress",
      withRelation: true,
      updatedAt: twoHoursAgo,
    });

    const { sweep } = sweepWith();
    // Sweep runs at NOW. Before this pass, the task was unswept for 2 hours.
    const result = await sweep.sweep({ force: true, at: NOW });
    expect(result.oldestUnsweptAgeMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 1000);
    expect(result.starvationAlert).toBe(true);

    // After this pass, the task was swept (age is now ~0ms), so next sweep has age < 1 hour
    const secondResult = await sweep.sweep({ force: true, at: new Date(NOW.getTime() + 10_000) });
    expect(secondResult.oldestUnsweptAgeMs).toBeLessThan(60 * 60 * 1000);
    expect(secondResult.starvationAlert).toBe(false);
  });
});
