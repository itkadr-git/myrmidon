// myrmidon(1.6.5 OPE-6608, review item 2): the issue service hands the board
// matcher the events that make a task available — a ready ownerless task was
// created, or a change made one (owner taken off, status into the queue).
// Real service over a real database; the matcher side is a spy sink.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { setSwarmEventSink } from "../myrmidon/swarm-claim/events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describeEmbeddedPostgres("issue service -> swarm matcher events", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const forIssue = vi.fn(async (_issueId: string) => null);
  const forAgent = vi.fn(async (_agentId: string) => null);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-swarm-issue-events-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    forIssue.mockClear();
    forAgent.mockClear();
    setSwarmEventSink({ forIssue, forAgent });
  });

  afterEach(async () => {
    setSwarmEventSink(null);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
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

  it("creating a ready ownerless task asks the matcher to pair it", async () => {
    const { companyId } = await seed();
    const created = await issueService(db).create(companyId, {
      title: "Ready task",
      description: null,
      status: "todo",
      priority: "medium",
    });
    await flush();
    expect(forIssue).toHaveBeenCalledTimes(1);
    expect(forIssue).toHaveBeenCalledWith(created.id);
  });

  it("creating a task that already has an owner, or is not ready, matches nothing", async () => {
    const { companyId, agentId } = await seed();
    const svc = issueService(db);
    await svc.create(companyId, { title: "Owned", description: null, status: "todo", priority: "medium", assigneeAgentId: agentId });
    await svc.create(companyId, { title: "Parked", description: null, status: "backlog", priority: "medium" });
    await flush();
    expect(forIssue).not.toHaveBeenCalled();
  });

  it("taking the owner off a task, or moving it into the queue, asks the matcher; unrelated edits do not", async () => {
    const { companyId, agentId } = await seed();
    const svc = issueService(db);
    const owned = await svc.create(companyId, { title: "Owned", description: null, status: "todo", priority: "medium", assigneeAgentId: agentId });
    const parked = await svc.create(companyId, { title: "Parked", description: null, status: "backlog", priority: "medium" });
    await flush();
    forIssue.mockClear();

    // An edit that does not touch availability: silent.
    await svc.update(owned.id, { title: "Owned, renamed" });
    await flush();
    expect(forIssue).not.toHaveBeenCalled();

    // The owner taken off a ready task: the task is available.
    await svc.update(owned.id, { assigneeAgentId: null });
    await flush();
    expect(forIssue).toHaveBeenCalledWith(owned.id);
    forIssue.mockClear();

    // Moved from backlog into the queue.
    await svc.update(parked.id, { status: "todo" });
    await flush();
    expect(forIssue).toHaveBeenCalledWith(parked.id);
    forIssue.mockClear();

    // Left the queue: nothing to pair.
    await svc.update(parked.id, { status: "in_progress" });
    await flush();
    expect(forIssue).not.toHaveBeenCalled();
  });

  it("a matcher that throws never fails the issue write", async () => {
    const { companyId } = await seed();
    forIssue.mockRejectedValueOnce(new Error("matcher down"));
    const created = await issueService(db).create(companyId, {
      title: "Ready task",
      description: null,
      status: "todo",
      priority: "medium",
    });
    await flush();
    expect(created.id).toBeTruthy();
  });

  it("with no sink installed (swarm not wired) writes behave as before", async () => {
    const { companyId } = await seed();
    setSwarmEventSink(null);
    const created = await issueService(db).create(companyId, {
      title: "Ready task",
      description: null,
      status: "todo",
      priority: "medium",
    });
    await flush();
    expect(created.status).toBe("todo");
    expect(forIssue).not.toHaveBeenCalled();
  });
});
