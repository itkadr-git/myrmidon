// server/src/myrmidon/wake-task-guard-parked-task.myrmidon.test.ts
//
// myrmidon(EMPTY-RUNS-1): a task its own agent keeps handing back to the queue
// cools down. Run liveness marks a run "advanced" for any activity row
// attributed to it, the board's own rows included, so a run that took a `todo`
// task, found nothing to do and put it back looked healthy and the cooling of
// design §4.3 never started (13.11: three service bots, ten parked tasks, 176
// pickups in eight hours). The cooling now asks what the run left on the task.
//
// Embedded Postgres harness follows wake-task-guard.myrmidon.test.ts.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSwarmSettings } from "@myrmidon/shared";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  decideIssueCooling,
  isIssueCoolingDown,
  type CoolingRun,
} from "./wake-task-guard.js";

describe("myrmidon(EMPTY-RUNS-1) cooling decision for runs without issue progress (pure)", () => {
  const settings = { cooldownBaseMin: 30, cooldownCeilingHours: 24 };
  const now = new Date("2026-11-13T08:00:00Z");

  /** Newest first: run i finished 5 + 20*i minutes ago. */
  function advancedRuns(progress: Array<boolean | undefined>): CoolingRun[] {
    return progress.map((madeIssueProgress, i) => {
      const finishedAt = new Date(now.getTime() - (5 + 20 * i) * 60_000);
      return {
        agentId: "agent-1",
        status: "succeeded",
        livenessState: "advanced",
        finishedAt,
        startedAt: new Date(finishedAt.getTime() - 40_000),
        createdAt: new Date(finishedAt.getTime() - 40_000),
        ...(madeIssueProgress === undefined ? {} : { madeIssueProgress }),
      };
    });
  }

  it("an advanced run that left nothing on a todo task starts the cooling", () => {
    const res = decideIssueCooling({ issueStatus: "todo", runs: advancedRuns([false]), moves: [], settings, now });
    expect(res.cooling).toBe(true);
    expect(res.staleCount).toBe(1);
    expect(res.cooldownMin).toBe(30);
    expect(res.reason).toBe("no_progress");
  });

  it("the window grows with every further run that left nothing", () => {
    const two = decideIssueCooling({ issueStatus: "todo", runs: advancedRuns([false, false]), moves: [], settings, now });
    expect(two).toMatchObject({ cooling: true, staleCount: 2, cooldownMin: 60 });
    const three = decideIssueCooling({ issueStatus: "todo", runs: advancedRuns([false, false, false]), moves: [], settings, now });
    expect(three).toMatchObject({ cooling: true, staleCount: 3, cooldownMin: 120 });
  });

  it("a run with real progress behind the parked ones stops the count", () => {
    const res = decideIssueCooling({ issueStatus: "todo", runs: advancedRuns([false, true, false]), moves: [], settings, now });
    expect(res).toMatchObject({ cooling: true, staleCount: 1, cooldownMin: 30 });
  });

  it("an advanced run with progress, or one nobody looked into, does not cool (as before)", () => {
    expect(decideIssueCooling({ issueStatus: "todo", runs: advancedRuns([true]), moves: [], settings, now }).cooling).toBe(false);
    expect(decideIssueCooling({ issueStatus: "todo", runs: advancedRuns([undefined]), moves: [], settings, now }).cooling).toBe(false);
  });

  it("only a task that sits in todo is judged this way", () => {
    for (const issueStatus of ["in_progress", "in_review", "blocked"]) {
      expect(decideIssueCooling({ issueStatus, runs: advancedRuns([false]), moves: [], settings, now }).cooling).toBe(false);
    }
  });

  it("a user or another agent moving the task after the run lifts the cooling", () => {
    const runs = advancedRuns([false]);
    const after = runs[0]!.finishedAt!.getTime() + 60_000;
    const decide = (moves: Parameters<typeof decideIssueCooling>[0]["moves"]) =>
      decideIssueCooling({ issueStatus: "todo", runs, moves, settings, now });
    expect(decide([{ at: after, actorType: "agent", actorId: "agent-1" }]).cooling).toBe(true);
    expect(decide([{ at: after, actorType: "system", actorId: "swarm_matcher" }]).cooling).toBe(true);
    expect(decide([{ at: after, actorType: "user", actorId: "u1" }]).cooling).toBe(false);
    expect(decide([{ at: after, actorType: "agent", actorId: "agent-2" }]).cooling).toBe(false);
  });

  it("the window ends after its period", () => {
    const later = new Date(now.getTime() + 30 * 60_000);
    expect(decideIssueCooling({ issueStatus: "todo", runs: advancedRuns([false]), moves: [], settings, now: later }).cooling).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("myrmidon(EMPTY-RUNS-1) parked task cooling against Postgres", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";
  let otherAgentId = "";
  const settings = resolveSwarmSettings(undefined);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-wake-guard-parked-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    otherAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: "WP",
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name] of [[agentId, "agent-a"], [otherAgentId, "agent-b"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true } },
        permissions: {},
      });
    }
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(status: "todo" | "in_progress" = "todo") {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Task ${issueId.slice(0, 4)}`,
      status,
      priority: "high",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  /** An automatic pickup run that ended `succeeded` and "advanced", as run liveness marks every such run. */
  async function seedAdvancedPickup(issueId: string, finishedAt: Date) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "succeeded",
      livenessState: "advanced",
      contextSnapshot: { issueId, wakeReason: "idle_pickup", source: "automation" },
      contextIssueId: issueId,
      contextWakeReason: "idle_pickup",
      startedAt: new Date(finishedAt.getTime() - 40_000),
      finishedAt,
    });
    return runId;
  }

  /** What the board logs under a run: its own checkout claim is there for every run. */
  async function logRunActivity(
    issueId: string,
    runId: string,
    at: Date,
    rows: Array<{ action: string; details?: Record<string, unknown>; system?: boolean }>,
  ) {
    for (const row of [{ action: "issue.swarm_claim.claimed", details: { source: "checkout", leaseTtlSec: 900 }, system: true }, ...rows]) {
      await db.insert(activityLog).values({
        companyId,
        actorType: row.system ? "system" : "agent",
        actorId: row.system ? "swarm_claim" : agentId,
        agentId,
        runId,
        action: row.action,
        entityType: "issue",
        entityId: issueId,
        details: row.details ?? null,
        createdAt: at,
      });
    }
  }

  function handBack(runId: string) {
    return {
      action: "issue.updated",
      details: {
        source: "comment",
        status: "todo",
        changes: {
          status: { from: "in_progress", to: "todo" },
          statusVersion: { from: 1, to: 2 },
          checkoutRunId: { from: runId, to: null },
          executionRunId: { from: runId, to: null },
          executionLockedAt: { from: "2026-11-13T07:22:23.472Z", to: null },
          executionAgentNameKey: { from: "agent-a", to: null },
        },
      },
    };
  }
  const parkingNote = { action: "issue.comment_added", details: { commentId: randomUUID(), updated: true } };
  const echo = { action: "issue.comment_added", details: { commentId: randomUUID(), source: "run_presentation_resolver" } };

  it("a pickup that handed the task back with a note cools the task; the window doubles on the next one", async () => {
    const now = new Date();
    const issueId = await seedIssue("todo");

    const firstAt = new Date(now.getTime() - 40 * 60_000);
    const first = await seedAdvancedPickup(issueId, firstAt);
    await logRunActivity(issueId, first, new Date(firstAt.getTime() - 1_000), [handBack(first), parkingNote]);
    // 40 min after the first parked run its 30 min window is over.
    const afterFirstWindow = await isIssueCoolingDown(db, companyId, issueId, settings, now);
    expect(afterFirstWindow.cooling).toBe(false);
    // Inside the window the task waits.
    const insideFirst = await isIssueCoolingDown(db, companyId, issueId, settings, new Date(firstAt.getTime() + 10 * 60_000));
    expect(insideFirst).toMatchObject({ cooling: true, staleCount: 1, cooldownMin: 30, reason: "no_progress" });

    const secondAt = new Date(now.getTime() - 5 * 60_000);
    const second = await seedAdvancedPickup(issueId, secondAt);
    await logRunActivity(issueId, second, new Date(secondAt.getTime() - 1_000), [handBack(second), parkingNote]);
    const afterSecond = await isIssueCoolingDown(db, companyId, issueId, settings, now);
    expect(afterSecond).toMatchObject({ cooling: true, staleCount: 2, cooldownMin: 60, reason: "no_progress" });
    expect(afterSecond.nextWakeAt!.getTime()).toBe(secondAt.getTime() + 60 * 60_000);
  });

  it("a pickup that left only the board's bookkeeping, a release and the echo of its answer cools the task", async () => {
    const now = new Date();
    const issueId = await seedIssue("todo");
    const at = new Date(now.getTime() - 5 * 60_000);
    const runId = await seedAdvancedPickup(issueId, at);
    await logRunActivity(issueId, runId, new Date(at.getTime() - 1_000), [{ action: "issue.released" }, echo]);
    expect(await isIssueCoolingDown(db, companyId, issueId, settings, now)).toMatchObject({
      cooling: true,
      staleCount: 1,
      reason: "no_progress",
    });
  });

  it("a pickup that left real work on the task does not cool it", async () => {
    const now = new Date();
    const at = new Date(now.getTime() - 5 * 60_000);

    // handed back, but with a document written
    const withDocument = await seedIssue("todo");
    const docRun = await seedAdvancedPickup(withDocument, at);
    await logRunActivity(withDocument, docRun, new Date(at.getTime() - 1_000), [
      handBack(docRun),
      parkingNote,
      { action: "issue.document_updated", details: { key: "worklog" } },
    ]);
    expect((await isIssueCoolingDown(db, companyId, withDocument, settings, now)).cooling).toBe(false);

    // a comment of a run that never took the task out of todo is an answer, not a parking note
    const answered = await seedIssue("todo");
    const answerRun = await seedAdvancedPickup(answered, at);
    await logRunActivity(answered, answerRun, new Date(at.getTime() - 1_000), [parkingNote]);
    expect((await isIssueCoolingDown(db, companyId, answered, settings, now)).cooling).toBe(false);
  });

  it("a task that is being worked on (in_progress) is not cooled by a quiet advanced run", async () => {
    const now = new Date();
    const issueId = await seedIssue("in_progress");
    const at = new Date(now.getTime() - 5 * 60_000);
    const runId = await seedAdvancedPickup(issueId, at);
    await logRunActivity(issueId, runId, new Date(at.getTime() - 1_000), [echo]);
    expect((await isIssueCoolingDown(db, companyId, issueId, settings, now)).cooling).toBe(false);
  });

  it("a comment of another agent after the parked run lifts the cooling", async () => {
    const now = new Date();
    const issueId = await seedIssue("todo");
    const at = new Date(now.getTime() - 5 * 60_000);
    const runId = await seedAdvancedPickup(issueId, at);
    await logRunActivity(issueId, runId, new Date(at.getTime() - 1_000), [handBack(runId), parkingNote]);
    expect((await isIssueCoolingDown(db, companyId, issueId, settings, now)).cooling).toBe(true);

    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "access is restored, go on",
      authorAgentId: otherAgentId,
      createdAt: new Date(now.getTime() - 60_000),
    });
    expect((await isIssueCoolingDown(db, companyId, issueId, settings, now)).cooling).toBe(false);
  });
});
