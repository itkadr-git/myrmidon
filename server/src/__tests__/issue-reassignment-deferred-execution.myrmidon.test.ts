// myrmidon(WAKE-STALL-B): when an issue is reassigned, deferred wakeups of the
// previous assignee for that issue are cancelled; other issues and other
// agents are left alone.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reassignment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cancelDeferredExecutionsForAgentOnReassignment", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = randomUUID();
  const oldAgentId = randomUUID();
  const otherAgentId = randomUUID();
  const issueId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-reassignment-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await db.insert(companies).values({
      id: companyId,
      name: "Reassignment Test Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [oldAgentId, otherAgentId].map((id) => ({
        id,
        companyId,
        name: `Agent ${id.slice(0, 4)}`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
  });

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function deferred(agentId: string, forIssueId: string) {
    return {
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      reason: "issue_execution_deferred",
      payload: { issueId: forIssueId },
      status: "deferred_issue_execution",
    };
  }

  async function statusesFor(agentId: string) {
    const rows = await db
      .select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    return rows;
  }

  it("cancels every deferred wakeup of the old assignee for the issue", async () => {
    await db.insert(agentWakeupRequests).values([deferred(oldAgentId, issueId), deferred(oldAgentId, issueId)]);

    const cancelled = await issueService(db).cancelDeferredExecutionsForAgentOnReassignment(
      oldAgentId,
      issueId,
      companyId,
    );

    expect(cancelled).toBe(2);
    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, oldAgentId), eq(agentWakeupRequests.status, "cancelled")));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.error).toContain("Cancelled due to issue reassignment");
  });

  it("leaves other issues and other agents untouched", async () => {
    const otherIssueId = randomUUID();
    await db
      .insert(agentWakeupRequests)
      .values([deferred(oldAgentId, issueId), deferred(oldAgentId, otherIssueId), deferred(otherAgentId, issueId)]);

    const cancelled = await issueService(db).cancelDeferredExecutionsForAgentOnReassignment(
      oldAgentId,
      issueId,
      companyId,
    );

    expect(cancelled).toBe(1);
    const oldRows = await statusesFor(oldAgentId);
    expect(oldRows.filter((r) => r.status === "cancelled")).toHaveLength(1);
    expect(
      oldRows.filter((r) => r.status === "deferred_issue_execution").map((r) => (r.payload as { issueId: string }).issueId),
    ).toEqual([otherIssueId]);
    expect((await statusesFor(otherAgentId)).map((r) => r.status)).toEqual(["deferred_issue_execution"]);
  });

  it("returns 0 when nothing is deferred", async () => {
    const cancelled = await issueService(db).cancelDeferredExecutionsForAgentOnReassignment(
      oldAgentId,
      issueId,
      companyId,
    );
    expect(cancelled).toBe(0);
  });
});
