import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issueLabels, issues, labels } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { idlePickupCandidateRows } from "../myrmidon/idle-pickup.js";
import { readSwarmQueueCounters } from "../myrmidon/swarm-claim/matcher.js";
import { applyRunPrioritySettings, currentRunPrioritySettings, resetRunPriorityForTests } from "../myrmidon/run-priority/state.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("release focus candidate queries", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("myrmidon-release-focus-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); });
  afterEach(async () => {
    resetRunPriorityForTests();
    await db.delete(activityLog);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  it("matches the entire release label rather than overlapping versions in both queries", async () => {
    applyRunPrioritySettings({ ...currentRunPrioritySettings({}), currentRelease: "1.6.9" });
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "company-collisions", issuePrefix: "RC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "engineer", role: "engineer", adapterType: "process" });
    const current = randomUUID();
    await db.insert(issues).values({ id: current, companyId, title: "current", status: "todo" });
    const currentLabel = randomUUID();
    await db.insert(labels).values({ id: currentLabel, companyId, name: "1.6.9", color: "#123456" });
    await db.insert(issueLabels).values({ companyId, issueId: current, labelId: currentLabel });
    for (const version of ["1.6.90", "1.6.99", "1.6"]) {
      const labelId = randomUUID();
      const assigned = randomUUID();
      const queued = randomUUID();
      await db.insert(labels).values({ id: labelId, companyId, name: version, color: "#123456" });
      await db.insert(issues).values([
        { id: assigned, companyId, title: version, status: "todo", assigneeAgentId: agentId },
        { id: queued, companyId, title: version, status: "todo" },
      ]);
      await db.insert(issueLabels).values([
        { companyId, issueId: assigned, labelId }, { companyId, issueId: queued, labelId },
      ]);
    }
    expect(await idlePickupCandidateRows(db, companyId, agentId)).toHaveLength(0);
    expect((await readSwarmQueueCounters(db, { companyIds: [companyId], now: new Date() })).queuedUnassigned).toBe(1);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, current));
    expect(await idlePickupCandidateRows(db, companyId, agentId)).toHaveLength(3);
    expect((await readSwarmQueueCounters(db, { companyIds: [companyId], now: new Date() })).queuedUnassigned).toBe(3);
  });

  it("rejects automatic assignments but accepts the owner's latest explicit assignment", async () => {
    applyRunPrioritySettings({ ...currentRunPrioritySettings({}), currentRelease: "1.6.9" });
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "company-a", issuePrefix: "RF" });
    await db.insert(agents).values({ id: agentId, companyId, name: "engineer-a", role: "engineer", adapterType: "process" });
    const current = randomUUID();
    const automatic = randomUUID();
    const manual = randomUUID();
    const review = randomUUID();
    const next = randomUUID();
    await db.insert(issues).values([
      { id: current, companyId, title: "current", status: "todo", assigneeAgentId: agentId },
      { id: automatic, companyId, title: "automatic", status: "todo", assigneeAgentId: agentId },
      { id: manual, companyId, title: "manual", status: "todo", assigneeAgentId: agentId },
      { id: next, companyId, title: "next", status: "todo" },
      { id: review, companyId, title: "review", status: "in_review", assigneeAgentId: agentId,
        executionState: { currentParticipant: { type: "agent", agentId } } },
    ]);
    const labelId = randomUUID();
    await db.insert(labels).values({ id: labelId, companyId, name: "1.6.9", color: "#123456" });
    await db.insert(issueLabels).values({ companyId, issueId: current, labelId });
    const assign = async (issueId: string, actorType: string, time: number) => {
      await db.insert(activityLog).values({ companyId, entityType: "issue", entityId: issueId,
        actorType, actorId: actorType === "user" ? "owner" : agentId, action: "issue.updated",
        details: { assigneeAgentId: agentId }, createdAt: new Date(time) });
    };
    await assign(automatic, "agent", 1000);
    await assign(manual, "user", 1000);
    const candidates = () => idlePickupCandidateRows(db, companyId, agentId);
    expect((await candidates()).map((row) => row.id).sort()).toEqual([current, manual, review].sort());
    expect((await readSwarmQueueCounters(db, { companyIds: [companyId], now: new Date() })).queuedUnassigned).toBe(0);
    await assign(manual, "agent", 2000);
    expect((await candidates()).map((row) => row.id).sort()).toEqual([current, review].sort());
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, current));
    expect((await candidates()).map((row) => row.id).sort()).toEqual([automatic, manual, review].sort());
    expect((await readSwarmQueueCounters(db, { companyIds: [companyId], now: new Date() })).queuedUnassigned).toBe(1);
  });
});
