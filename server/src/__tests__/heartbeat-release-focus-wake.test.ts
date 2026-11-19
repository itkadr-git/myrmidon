import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueLabels, issues, labels } from "@myrmidon/db";
import { findTopReadyIssueForAgent } from "../myrmidon/idle-pickup.js";
import { applyCompanyReleaseFocus, resetRunPriorityForTests } from "../myrmidon/run-priority/state.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("release-focused idle-pickup task selection", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("release-focus-wake-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    resetRunPriorityForTests();
    await database?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    applyCompanyReleaseFocus(new Map([[companyId, { currentRelease: "1.6.9", strictReleaseFocus: true }]]));
    const agentId = randomUUID();
    const currentId = randomUUID();
    const otherId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Release focus", issuePrefix: `T${companyId.slice(0, 6)}` });
    // Stop admitted timer wakes before invoking an adapter.
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { enabled: false } } });
    await db.insert(issues).values([
      { id: currentId, companyId, title: "Current", status: "in_progress", priority: "low", assigneeAgentId: agentId },
      { id: otherId, companyId, title: "Other", status: "in_progress", priority: "critical", assigneeAgentId: agentId },
    ]);
    for (const [issueId, name] of [[currentId, "1.6.9"], [otherId, "1.8"]]) {
      const [label] = await db.insert(labels).values({ companyId, name, color: "#123456" }).returning();
      await db.insert(issueLabels).values({ companyId, issueId, labelId: label.id });
    }
    return { companyId, agentId, currentId, otherId };
  }

  it("selects current-release work ahead of a higher priority other-release task", async () => {
    const { companyId, agentId, currentId, otherId } = await seed();
    expect((await findTopReadyIssueForAgent(db, { id: agentId, companyId }))?.id).toBe(currentId);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, currentId));
    expect((await findTopReadyIssueForAgent(db, { id: agentId, companyId }))?.id).toBe(otherId);
  });

  it("strictReleaseFocus=false lifts the selection filter, true restores it, no restart", async () => {
    const { companyId, agentId, currentId } = await seed();
    const on = { currentRelease: "1.6.9", strictReleaseFocus: true };
    try {
      applyCompanyReleaseFocus(new Map([[companyId, { ...on, strictReleaseFocus: false }]]));
      expect(await findTopReadyIssueForAgent(db, { id: agentId, companyId })).not.toBeNull();
      applyCompanyReleaseFocus(new Map([[companyId, on]]));
      expect((await findTopReadyIssueForAgent(db, { id: agentId, companyId }))?.id).toBe(currentId);
    } finally {
      resetRunPriorityForTests();
    }
  });
});
