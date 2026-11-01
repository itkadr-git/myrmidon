import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDb,
  companies,
  agents,
  issues,
  issueRelations,
  activityLog,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres open blocker transition tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("open blocker transitions (OPE-9556)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-open-blocker-trans-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
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
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("transitions in_progress task to blocked when blocker added, and restores to in_progress on blocker done (OPE-9556)", async () => {
    const { companyId, agentId } = await seed();
    const svc = issueService(db);

    const blocker = await svc.create(companyId, {
      title: "Blocker task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const task = await svc.create(companyId, {
      title: "Main task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    expect(task.status).toBe("in_progress");

    // Adding open blocker transitions in_progress -> blocked
    const blockedTask = await svc.update(task.id, {
      blockedByIssueIds: [blocker.id],
    });
    expect(blockedTask.status).toBe("blocked");
    expect((blockedTask.blockerMetadata as any)?.previousStatus).toBe("in_progress");

    // Closing the blocker restores the task to in_progress
    await svc.update(blocker.id, { status: "done" });

    const restoredTask = await svc.getById(task.id);
    expect(restoredTask.status).toBe("in_progress");
  });

  it("transitions todo task to blocked when blocker added, and restores to todo on blocker done (OPE-9556)", async () => {
    const { companyId, agentId } = await seed();
    const svc = issueService(db);

    const blocker = await svc.create(companyId, {
      title: "Blocker task",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const task = await svc.create(companyId, {
      title: "Main task",
      status: "todo",
      assigneeAgentId: agentId,
    });
    expect(task.status).toBe("todo");

    // Adding open blocker transitions todo -> blocked
    const blockedTask = await svc.update(task.id, {
      blockedByIssueIds: [blocker.id],
    });
    expect(blockedTask.status).toBe("blocked");
    expect((blockedTask.blockerMetadata as any)?.previousStatus).toBe("todo");

    // Closing the blocker restores the task to todo
    await svc.update(blocker.id, { status: "done" });

    const restoredTask = await svc.getById(task.id);
    expect(restoredTask.status).toBe("todo");
  });

  it("restores previous status when blocker is cancelled (OPE-9556)", async () => {
    const { companyId, agentId } = await seed();
    const svc = issueService(db);

    const blocker = await svc.create(companyId, {
      title: "Blocker task",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const task = await svc.create(companyId, {
      title: "Main task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    await svc.update(task.id, {
      blockedByIssueIds: [blocker.id],
    });

    // Cancelling blocker also releases the reasonless block
    await svc.update(blocker.id, { status: "cancelled" });

    const restoredTask = await svc.getById(task.id);
    expect(restoredTask.status).toBe("in_progress");
  });

  it("remains blocked until all blockers are resolved (OPE-9556)", async () => {
    const { companyId, agentId } = await seed();
    const svc = issueService(db);

    const blocker1 = await svc.create(companyId, {
      title: "Blocker 1",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const blocker2 = await svc.create(companyId, {
      title: "Blocker 2",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const task = await svc.create(companyId, {
      title: "Main task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    await svc.update(task.id, {
      blockedByIssueIds: [blocker1.id, blocker2.id],
    });

    // Resolving only one blocker leaves it blocked
    await svc.update(blocker1.id, { status: "done" });
    const stillBlocked = await svc.getById(task.id);
    expect(stillBlocked.status).toBe("blocked");

    // Resolving second blocker restores in_progress
    await svc.update(blocker2.id, { status: "done" });
    const restored = await svc.getById(task.id);
    expect(restored.status).toBe("in_progress");
  });

  it("restores previous status when blockers are removed via blockedByIssueIds (OPE-9556)", async () => {
    const { companyId, agentId } = await seed();
    const svc = issueService(db);

    const blocker = await svc.create(companyId, {
      title: "Blocker task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const task = await svc.create(companyId, {
      title: "Main task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    await svc.update(task.id, {
      blockedByIssueIds: [blocker.id],
    });
    const blocked = await svc.getById(task.id);
    expect(blocked.status).toBe("blocked");

    // Unlink the blocker
    const unblocked = await svc.update(task.id, {
      blockedByIssueIds: [],
    });
    expect(unblocked.status).toBe("in_progress");
  });

  it("task with blockReason remains blocked when dependency blocker is closed (OPE-9556)", async () => {
    const { companyId, agentId } = await seed();
    const svc = issueService(db);

    const blocker = await svc.create(companyId, {
      title: "Blocker task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const task = await svc.create(companyId, {
      title: "Task with manual block reason",
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    // Blocker added -> moved to blocked
    await svc.update(task.id, {
      blockedByIssueIds: [blocker.id],
    });

    // Set a manual blockReason on the blocked task
    await svc.update(task.id, {
      blockerMetadata: {
        blockReason: "Waiting for manual review",
        previousStatus: "in_progress",
      },
    });

    // Close the dependency blocker
    await svc.update(blocker.id, { status: "done" });

    // Task must remain blocked and preserve its manual blockReason
    const stillBlocked = await svc.getById(task.id);
    expect(stillBlocked.status).toBe("blocked");
    expect((stillBlocked.blockerMetadata as any)?.blockReason).toBe("Waiting for manual review");
  });

  it("task with blockReason remains blocked when dependency blocker is removed via blockedByIssueIds (OPE-9556)", async () => {
    const { companyId, agentId } = await seed();
    const svc = issueService(db);

    const blocker = await svc.create(companyId, {
      title: "Blocker task",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const task = await svc.create(companyId, {
      title: "Task with initial manual block reason",
      status: "blocked",
      blockerMetadata: {
        blockReason: "External blocker reason",
      },
      assigneeAgentId: agentId,
    });

    // Add dependency blocker
    await svc.update(task.id, {
      blockedByIssueIds: [blocker.id],
    });

    // Remove dependency blocker
    const result = await svc.update(task.id, {
      blockedByIssueIds: [],
    });

    // Task must remain blocked and preserve blockReason
    expect(result.status).toBe("blocked");
    expect((result.blockerMetadata as any)?.blockReason).toBe("External blocker reason");
  });
});
