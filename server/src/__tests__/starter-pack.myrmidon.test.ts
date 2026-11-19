// myrmidon(OPE-13095): the starter-pack scout wakes before the first engineer run.
// The pure "place the scout or not" rule runs without a database; the wakes, the
// run dispatch admission and the once-only wake of the assignee run on embedded
// Postgres, the same way as run-guard-escalate.myrmidon.test.ts.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, instanceSettings, issueDocuments, issues, documents } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import {
  STARTER_PACK_DOCUMENT_KEY,
  STARTER_PACK_READY_SOURCE,
  STARTER_PACK_SCOUT_SOURCE,
  STARTER_PACK_SCOUT_WAKE_REASON,
  buildStarterPackReadyWakeIdempotencyKey,
  hasStarterPackScoutWake,
  isStarterPackScoutIssueStatus,
  isStarterPackScoutRunContext,
  isStarterPackScoutWake,
  isStarterPackScoutWriteAllowed,
  buildStarterPackScoutWakeIdempotencyKey,
  maybeWakeStarterPackScout,
  readStarterPackAgentId,
  shouldPlaceStarterPackScout,
  wakeAssigneeAfterStarterPack,
} from "../myrmidon/starter-pack.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres starter-pack tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("shouldPlaceStarterPackScout", () => {
  const base = {
    scoutAgentId: "scout",
    assigneeAgentId: "engineer-1",
    assigneeRole: "engineer",
    description: "Do the thing",
    hasStarterPackDocument: false,
  };

  it("places the scout for a new engineer task", () => {
    expect(shouldPlaceStarterPackScout(base)).toBe(true);
  });

  it("keeps the old behaviour when the setting is not set", () => {
    expect(shouldPlaceStarterPackScout({ ...base, scoutAgentId: null })).toBe(false);
  });

  it("keeps the old behaviour when the task already has the document", () => {
    expect(shouldPlaceStarterPackScout({ ...base, hasStarterPackDocument: true })).toBe(false);
  });

  it("keeps the old behaviour when the description already has the heading", () => {
    expect(
      shouldPlaceStarterPackScout({ ...base, description: "Intro\n\n### Стартовый пакет\n- file.ts" }),
    ).toBe(false);
  });

  it("keeps the old behaviour when the assignee is not an engineer", () => {
    expect(shouldPlaceStarterPackScout({ ...base, assigneeRole: "reviewer" })).toBe(false);
    expect(shouldPlaceStarterPackScout({ ...base, assigneeRole: null })).toBe(false);
  });

  it("does not place the scout on its own task or on a task without an assignee", () => {
    expect(shouldPlaceStarterPackScout({ ...base, assigneeAgentId: "scout" })).toBe(false);
    expect(shouldPlaceStarterPackScout({ ...base, assigneeAgentId: null })).toBe(false);
  });
});

describe("starter-pack scout pure guards", () => {
  it("leaves the per-run hook without a query for a run that is not the scout's wake", () => {
    expect(isStarterPackScoutRunContext({ source: "issue.create", wakeReason: "issue_assigned" }, "assignment")).toBe(false);
    expect(isStarterPackScoutRunContext({}, "automation")).toBe(false);
    expect(isStarterPackScoutRunContext(null)).toBe(false);
    expect(
      isStarterPackScoutRunContext({ source: STARTER_PACK_SCOUT_SOURCE, wakeReason: STARTER_PACK_SCOUT_WAKE_REASON }, "automation"),
    ).toBe(true);
  });

  it("admits the scout's run only on a todo or in_progress task", () => {
    expect(isStarterPackScoutIssueStatus("todo")).toBe(true);
    expect(isStarterPackScoutIssueStatus("in_progress")).toBe(true);
    expect(isStarterPackScoutIssueStatus("blocked")).toBe(false);
    expect(isStarterPackScoutIssueStatus("done")).toBe(false);
  });

  it("allows the document write only for the scout, the key starter-pack and a woken task", () => {
    const allow = isStarterPackScoutWriteAllowed;
    expect(allow("starter-pack", "scout", "scout", true)).toBe(true);
    expect(allow("notes", "scout", "scout", true)).toBe(false);
    expect(allow("starter-pack", "other", "scout", true)).toBe(false);
    expect(allow("starter-pack", "scout", "scout", false)).toBe(false);
    expect(allow("starter-pack", "scout", null, true)).toBe(false);
  });
});

describeEmbeddedPostgres("the starter-pack scout on a new engineer task", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-starter-pack-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { actor?: unknown }).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  async function setScout(agentId: string | null) {
    const general = agentId ? { starterPackAgentId: agentId } : {};
    await db
      .insert(instanceSettings)
      .values({ singletonKey: "default", general, experimental: {} })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { general } });
  }

  async function seed(input: { companyId?: string; issuePrefix?: string; assigneeRole?: string; description?: string | null } = {}) {
    const companyId = input.companyId ?? randomUUID();
    const issuePrefix = input.issuePrefix ?? `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    if (!input.companyId) {
      await db.insert(companies).values({
        id: companyId,
        name: "company-a",
        issuePrefix,
        defaultResponsibleUserId: "responsible-user",
        requireBoardApprovalForNewAgents: false,
      });
    }
    const insertAgent = async (name: string, role: string) => {
      const id = randomUUID();
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role,
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return id;
    };
    const scoutId = await insertAgent("Scout", "researcher");
    const engineerId = await insertAgent("Engineer", input.assigneeRole ?? "engineer");
    const issueId = randomUUID();
    const issueNumber = input.companyId ? 2 : 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "New task",
      description: input.description ?? null,
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: engineerId,
      issueNumber,
      identifier: `${issuePrefix}-${issueNumber}`,
    });
    return { companyId, issuePrefix, issueId, scoutId, engineerId, issue: { id: issueId, companyId, assigneeAgentId: engineerId, description: input.description ?? null } };
  }

  function recorder() {
    const calls: Array<{ agentId: string; opts: Record<string, unknown> }> = [];
    const enqueue = async (agentId: string, opts: Record<string, unknown>) => {
      calls.push({ agentId, opts });
      return { id: randomUUID() };
    };
    return { calls, enqueue: enqueue as unknown as Parameters<typeof maybeWakeStarterPackScout>[1] };
  }

  it("reads the setting, and nothing when it is not set", async () => {
    const { scoutId } = await seed();
    await setScout(null);
    expect(await readStarterPackAgentId(db)).toBeNull();
    await setScout(scoutId);
    expect(await readStarterPackAgentId(db)).toBe(scoutId);
  });

  it("wakes the scout and reports that the assignee is not to be woken yet", async () => {
    const { scoutId, issue, issueId } = await seed();
    await setScout(scoutId);
    const { calls, enqueue } = recorder();

    expect(await maybeWakeStarterPackScout(db, enqueue, issue)).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.agentId).toBe(scoutId);
    expect(calls[0]!.opts).toMatchObject({
      source: "automation",
      reason: STARTER_PACK_SCOUT_WAKE_REASON,
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: STARTER_PACK_SCOUT_WAKE_REASON, source: STARTER_PACK_SCOUT_SOURCE },
    });
  });

  it("finds the scout's wake request only for the task it was woken for", async () => {
    const { companyId, scoutId, issueId } = await seed();
    const otherIssueId = randomUUID();
    expect(await hasStarterPackScoutWake(db, { companyId, issueId, scoutAgentId: scoutId })).toBe(false);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: scoutId,
      source: "automation",
      triggerDetail: "system",
      reason: STARTER_PACK_SCOUT_WAKE_REASON,
      payload: { issueId },
      status: "skipped",
      idempotencyKey: buildStarterPackScoutWakeIdempotencyKey(issueId),
    });
    expect(await hasStarterPackScoutWake(db, { companyId, issueId, scoutAgentId: scoutId })).toBe(true);
    expect(await hasStarterPackScoutWake(db, { companyId, issueId: otherIssueId, scoutAgentId: scoutId })).toBe(false);
  });

  it("wakes nobody (the caller wakes the assignee as before) when the setting is not set", async () => {
    const { issue } = await seed();
    await setScout(null);
    const { calls, enqueue } = recorder();

    expect(await maybeWakeStarterPackScout(db, enqueue, issue)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("wakes nobody when the task already has a starter-pack document", async () => {
    const { scoutId, issue, issueId, companyId } = await seed();
    await setScout(scoutId);
    const documentId = randomUUID();
    await db.insert(documents).values({ id: documentId, companyId, title: "pack", format: "markdown", latestBody: "x", latestRevisionNumber: 1 });
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: STARTER_PACK_DOCUMENT_KEY });
    const { calls, enqueue } = recorder();

    expect(await maybeWakeStarterPackScout(db, enqueue, issue)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("wakes nobody when the description already has the heading", async () => {
    const { scoutId, issue } = await seed({ description: "Text\n\n### Стартовый пакет\nfiles" });
    await setScout(scoutId);
    const { calls, enqueue } = recorder();

    expect(await maybeWakeStarterPackScout(db, enqueue, issue)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("wakes nobody when the assignee is not an engineer", async () => {
    const { scoutId, issue } = await seed({ assigneeRole: "reviewer" });
    await setScout(scoutId);
    const { calls, enqueue } = recorder();

    expect(await maybeWakeStarterPackScout(db, enqueue, issue)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("lets the run dispatch start the scout's wake only for the configured scout on another agent's task", async () => {
    const { companyId, scoutId, engineerId } = await seed();
    await setScout(scoutId);
    const other = await seed();

    expect(await isStarterPackScoutWake(db, { companyId, assigneeAgentId: engineerId, agentId: scoutId })).toBe(true);
    // The assignee itself, a stranger and an agent of another company are not the scout.
    expect(await isStarterPackScoutWake(db, { companyId, assigneeAgentId: engineerId, agentId: engineerId })).toBe(false);
    expect(await isStarterPackScoutWake(db, { companyId, assigneeAgentId: engineerId, agentId: other.scoutId })).toBe(false);
    await setScout(null);
    expect(await isStarterPackScoutWake(db, { companyId, assigneeAgentId: engineerId, agentId: scoutId })).toBe(false);
  });

  it("wakes the assignee exactly once after the document and after the end of the scout's run", async () => {
    const { companyId, issueId, engineerId, issue } = await seed();
    const queued: string[] = [];
    // The wake the board queues: one agent_wakeup_requests row with the idempotency key.
    const queueWake = async (idempotencyKey: string) => {
      queued.push(idempotencyKey);
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId: engineerId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId, mutation: "starter_pack" },
        status: "queued",
        idempotencyKey,
      });
    };

    // First the document is saved, then the scout's run ends without anything left to do.
    expect(await wakeAssigneeAfterStarterPack(db, issue, queueWake)).toBe(true);
    expect(await wakeAssigneeAfterStarterPack(db, issue, queueWake)).toBe(false);

    expect(queued).toEqual([buildStarterPackReadyWakeIdempotencyKey(issueId)]);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_assigned")));
    expect(wakes).toHaveLength(1);
    expect(STARTER_PACK_READY_SOURCE).toBe("starter_pack.ready");
  });

  it("wakes the assignee from the fallback when the scout's run ended without a document", async () => {
    const { issueId, issue } = await seed();
    const queued: string[] = [];

    expect(await wakeAssigneeAfterStarterPack(db, issue, (key) => void queued.push(key))).toBe(true);
    expect(queued).toEqual([buildStarterPackReadyWakeIdempotencyKey(issueId)]);
  });

  it("enforces document permissions over the route: 403 on another key, 201 on starter-pack and wakes assignee once", async () => {
    const { companyId, issuePrefix, scoutId, engineerId, issueId } = await seed();
    await setScout(scoutId);

    // Scout has been woken for this task
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: scoutId,
      source: "automation",
      triggerDetail: "system",
      reason: STARTER_PACK_SCOUT_WAKE_REASON,
      payload: { issueId },
      status: "queued",
      idempotencyKey: buildStarterPackScoutWakeIdempotencyKey(issueId),
    });

    const app = createApp({
      type: "agent",
      agentId: scoutId,
      companyId,
      source: "agent_key",
    });

    // 1. Scout writes a document with another key -> 403 forbidden
    const forbiddenRes = await request(app)
      .put(`/api/issues/${issueId}/documents/notes`)
      .send({ format: "markdown", body: "# Scout Notes" });
    expect(forbiddenRes.status).toBe(403);
    expect(forbiddenRes.body.error).toBe("Agent cannot mutate another agent's issue");

    const forbiddenPlanRes = await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# Scout Plan" });
    expect(forbiddenPlanRes.status).toBe(403);
    expect(forbiddenPlanRes.body.error).toBe("Agent cannot mutate another agent's issue");

    // No document was created for notes or plan
    const docsAfterForbidden = await db
      .select()
      .from(documents)
      .where(eq(documents.companyId, companyId));
    expect(docsAfterForbidden).toHaveLength(0);

    // 2. Another agent (not scout and not assignee) tries to write starter-pack -> 403 forbidden
    const strangerId = randomUUID();
    await db.insert(agents).values({
      id: strangerId,
      companyId,
      name: "Stranger",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const strangerApp = createApp({
      type: "agent",
      agentId: strangerId,
      companyId,
      source: "agent_key",
    });
    const strangerRes = await request(strangerApp)
      .put(`/api/issues/${issueId}/documents/starter-pack`)
      .send({ format: "markdown", body: "# Intruder" });
    expect(strangerRes.status).toBe(403);
    expect(strangerRes.body.error).toBe("Agent cannot mutate another agent's issue");

    // 3. Scout writes starter-pack on a task it was NOT woken for -> 403 forbidden
    const other = await seed({ companyId, issuePrefix });
    const unsolicitedRes = await request(app)
      .put(`/api/issues/${other.issueId}/documents/starter-pack`)
      .send({ format: "markdown", body: "# Unsolicited" });
    expect(unsolicitedRes.status).toBe(403);
    expect(unsolicitedRes.body.error).toBe("Agent cannot mutate another agent's issue");

    // 4. Scout writes starter-pack -> 201 and document is created
    const createdRes = await request(app)
      .put(`/api/issues/${issueId}/documents/starter-pack`)
      .send({ format: "markdown", body: "### Starter pack\n\nCode summary for engineer" });
    expect(createdRes.status).toBe(201);
    expect(createdRes.body.key).toBe("starter-pack");
    expect(typeof createdRes.body.latestRevisionId).toBe("string");

    // 5. Assignee was woken exactly once
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, engineerId),
          eq(agentWakeupRequests.reason, "issue_assigned"),
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.idempotencyKey).toBe(buildStarterPackReadyWakeIdempotencyKey(issueId));

    // 6. Repeated update (with the current baseRevisionId, as the document route requires
    // for any update of an existing document) returns 200 and does not queue another wake
    const updateRes = await request(app)
      .put(`/api/issues/${issueId}/documents/starter-pack`)
      .send({
        format: "markdown",
        body: "### Starter pack v2",
        baseRevisionId: createdRes.body.latestRevisionId,
      });
    expect(updateRes.status).toBe(200);

    const wakesAfterUpdate = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, engineerId),
          eq(agentWakeupRequests.reason, "issue_assigned"),
        ),
      );
    expect(wakesAfterUpdate).toHaveLength(1);

    // 7. Fallback wake after the scout's run ends is a no-op because wake was already queued
    expect(
      await wakeAssigneeAfterStarterPack(
        db,
        { id: issueId, companyId, assigneeAgentId: engineerId },
        () => {},
      ),
    ).toBe(false);
  });
});
