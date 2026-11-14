// myrmidon(OPE-13095): the starter-pack scout wakes before the first engineer run.
// The pure "place the scout or not" rule runs without a database; the wakes, the
// run dispatch admission and the once-only wake of the assignee run on embedded
// Postgres, the same way as run-guard-escalate.myrmidon.test.ts.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, instanceSettings, issueDocuments, issues, documents } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  STARTER_PACK_DOCUMENT_KEY,
  STARTER_PACK_READY_SOURCE,
  STARTER_PACK_SCOUT_SOURCE,
  STARTER_PACK_SCOUT_WAKE_REASON,
  buildStarterPackReadyWakeIdempotencyKey,
  isStarterPackScoutWake,
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

  async function setScout(agentId: string | null) {
    const general = agentId ? { starterPackAgentId: agentId } : {};
    await db
      .insert(instanceSettings)
      .values({ singletonKey: "default", general, experimental: {} })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { general } });
  }

  async function seed(input: { assigneeRole?: string; description?: string | null } = {}) {
    const companyId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
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
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "New task",
      description: input.description ?? null,
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: engineerId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, issueId, scoutId, engineerId, issue: { id: issueId, companyId, assigneeAgentId: engineerId, description: input.description ?? null } };
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
});
