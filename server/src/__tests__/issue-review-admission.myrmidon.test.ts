import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("myrmidon review admission wake persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("review-admission-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Review Admission Test Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Admission Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 20_000);

  afterAll(async () => {
    await db.delete(issues);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  it("rolls back a review status change if persisting its wake receipt fails", async () => {
    const idempotencyKey = `issue-review-admission:${issueId}:${agentId}`;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Atomic review admission",
      status: "todo",
      assigneeAgentId: agentId,
    });

    await expect(db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
      await tx.insert(agentWakeupRequests).values({
        companyId, agentId, source: "assignment", triggerDetail: "system",
        reason: "issue_entered_review", payload: { issueId },
        idempotencyKey,
      });
      throw new Error("simulated wake insert failure");
    })).rejects.toThrow("simulated wake insert failure");

    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("todo");

    await db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
      await tx.insert(agentWakeupRequests).values({
        companyId, agentId, source: "assignment", triggerDetail: "system",
        reason: "issue_entered_review", payload: { issueId }, idempotencyKey,
      });
    });

    const [reviewIssue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(reviewIssue?.status).toBe("in_review");
    const rows = await db
      .select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ issueId });
  });

  it("writes the issue change and reviewer wake in one transaction", async () => {
    const secondIssueId = randomUUID();
    const idempotencyKey = `issue-review-admission:${secondIssueId}:${agentId}`;
    await db.insert(issues).values({
      id: secondIssueId,
      companyId,
      title: "Atomic positive path",
      status: "todo",
      assigneeAgentId: agentId,
    });

    await db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "in_review" }).where(eq(issues.id, secondIssueId));
      await tx.insert(agentWakeupRequests).values({
        companyId, agentId, source: "assignment", triggerDetail: "system",
        reason: "issue_entered_review", payload: { issueId: secondIssueId }, idempotencyKey,
      });
    });

    const [reviewIssue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, secondIssueId));
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    expect(reviewIssue?.status).toBe("in_review");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ issueId: secondIssueId });
  });
});
