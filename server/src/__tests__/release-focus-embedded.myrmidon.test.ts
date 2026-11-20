import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issueLabels, issues, labels } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { idlePickupCandidateRows } from "../myrmidon/idle-pickup.js";
import { runViolatesReleaseFocus } from "../myrmidon/release-focus.js";
import { readSwarmQueueCounters } from "../myrmidon/swarm-claim/matcher.js";
import { applyCompanyReleaseFocus, resetRunPriorityForTests } from "../myrmidon/run-priority/state.js";
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
    const companyId = randomUUID();
    applyCompanyReleaseFocus(new Map([[companyId, { currentRelease: "1.6.9", strictReleaseFocus: true }]]));
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
    const companyId = randomUUID();
    applyCompanyReleaseFocus(new Map([[companyId, { currentRelease: "1.6.9", strictReleaseFocus: true }]]));
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
    const otherLabelId = randomUUID();
    await db.insert(labels).values([
      { id: labelId, companyId, name: "1.6.9", color: "#123456" },
      { id: otherLabelId, companyId, name: "1.8", color: "#123456" },
    ]);
    await db.insert(issueLabels).values([
      { companyId, issueId: current, labelId },
      ...[automatic, manual, next].map((issueId) => ({ companyId, issueId, labelId: otherLabelId })),
    ]);
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

  it("strictReleaseFocus=false hands out other-release tasks in both queries; true restricts again", async () => {
    const focused = { currentRelease: "1.6.9", strictReleaseFocus: true };
    const companyId = randomUUID();
    applyCompanyReleaseFocus(new Map([[companyId, focused]]));
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "company-flag", issuePrefix: "RG" });
    await db.insert(agents).values({ id: agentId, companyId, name: "engineer-flag", role: "engineer", adapterType: "process" });
    const current = randomUUID();
    const assigned18 = randomUUID();
    const queued18 = randomUUID();
    await db.insert(issues).values([
      { id: current, companyId, title: "current", status: "todo" },
      { id: assigned18, companyId, title: "assigned 1.8", status: "todo", assigneeAgentId: agentId },
      { id: queued18, companyId, title: "queued 1.8", status: "todo" },
    ]);
    const label169 = randomUUID();
    const label18 = randomUUID();
    await db.insert(labels).values([
      { id: label169, companyId, name: "1.6.9", color: "#123456" },
      { id: label18, companyId, name: "1.8", color: "#123456" },
    ]);
    await db.insert(issueLabels).values([
      { companyId, issueId: current, labelId: label169 },
      { companyId, issueId: assigned18, labelId: label18 },
      { companyId, issueId: queued18, labelId: label18 },
    ]);
    const queued = async () => (await readSwarmQueueCounters(db, { companyIds: [companyId], now: new Date() })).queuedUnassigned;
    expect(await idlePickupCandidateRows(db, companyId, agentId)).toHaveLength(0);
    expect(await queued()).toBe(1);
    applyCompanyReleaseFocus(new Map([[companyId, { ...focused, strictReleaseFocus: false }]]));
    expect((await idlePickupCandidateRows(db, companyId, agentId)).map((row) => row.id)).toEqual([assigned18]);
    expect(await queued()).toBe(2);
    applyCompanyReleaseFocus(new Map([[companyId, focused]]));
    expect(await idlePickupCandidateRows(db, companyId, agentId)).toHaveLength(0);
    expect(await queued()).toBe(1);
  });
  it("blocks only tasks of another release: unlabeled and non-release labels pass, mixed labels with the current one pass", async () => {
    const companyId = randomUUID();
    applyCompanyReleaseFocus(new Map([[companyId, { currentRelease: "1.7", strictReleaseFocus: true }]]));
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "company-unlabeled", issuePrefix: "RU" });
    await db.insert(agents).values({ id: agentId, companyId, name: "engineer-u", role: "engineer", adapterType: "process" });
    const names = ["1.7", "1.8", "bug", "ops"];
    const labelIds = new Map(names.map((name) => [name, randomUUID()]));
    await db.insert(labels).values(names.map((name) => ({ id: labelIds.get(name)!, companyId, name, color: "#123456" })));
    // Case name -> labels. "none" has no label at all.
    const cases: Record<string, string[]> = {
      none: [], current: [" 1.7 "], other: ["1.8"], bug: ["bug"], ops: ["ops", "bug"],
      both: ["1.7", "1.8"], otherAndBug: ["1.8", "bug"],
    };
    const expectedPass = ["none", "current", "bug", "ops", "both"].sort();
    const assignedIds = new Map<string, string>();
    const queuedIds: string[] = [];
    for (const [name, caseLabels] of Object.entries(cases)) {
      for (const assigned of [true, false]) {
        const id = randomUUID();
        await db.insert(issues).values({ id, companyId, title: name, status: "todo", assigneeAgentId: assigned ? agentId : null });
        if (assigned) assignedIds.set(id, name); else queuedIds.push(id);
        for (const label of caseLabels) {
          await db.insert(issueLabels).values({ companyId, issueId: id, labelId: labelIds.get(label.trim())! });
        }
      }
    }
    const passed = (await idlePickupCandidateRows(db, companyId, agentId)).map((row) => assignedIds.get(row.id)!).sort();
    expect(passed).toEqual(expectedPass);
    const queued = (await readSwarmQueueCounters(db, { companyIds: [companyId], now: new Date() })).queuedUnassigned;
    expect(queued).toBe(expectedPass.length);
    // The run-start gate uses the same predicate.
    for (const [id, name] of assignedIds) {
      expect(await runViolatesReleaseFocus(db, { companyId, agentId, issueId: id })).toBe(!expectedPass.includes(name));
    }
  });
});
