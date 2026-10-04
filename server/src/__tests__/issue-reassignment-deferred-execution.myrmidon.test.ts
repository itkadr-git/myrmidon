import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

import { db, agentWakeupRequests } from "@paperclipai/db";

import { issueServiceFactory } from "../services/issues";

describe("issue reassignment with deferred executions - comprehensive test", () => {
  const companyId = randomUUID();
  const oldAgentId = randomUUID();
  const newAgentId = randomUUID();
  const issueId = randomUUID();

  beforeEach(async () => {
    // Clean up any existing test data
    await db
      .delete(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`
        )
      );
  });

  afterEach(async () => {
    // Clean up after each test
    await db
      .delete(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`
        )
      );
  });

  it("cancels deferred executions for old assignee when issue is reassigned", async () => {
    // Create some deferred executions for the old agent related to this issue
    const deferredExecutions = await db
      .insert(agentWakeupRequests)
      .values([
        {
          id: randomUUID(),
          companyId,
          agentId: oldAgentId,
          source: "automation",
          reason: "issue_commented",
          payload: { issueId },
          status: "deferred_issue_execution",
          requestedAt: new Date(),
        },
        {
          id: randomUUID(),
          companyId,
          agentId: oldAgentId,
          source: "automation", 
          reason: "issue_assigned",
          payload: { issueId },
          status: "deferred_issue_execution",
          requestedAt: new Date(),
        },
      ])
      .returning();

    expect(deferredExecutions.length).toBe(2);

    // Verify they exist with the correct status
    const existingDeferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, oldAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`
        )
      );
    
    expect(existingDeferred.length).toBe(2);

    // Cancel deferred executions for reassignment
    const svc = issueServiceFactory(db);
    const cancelledCount = await svc.cancelDeferredExecutionsForAgentOnReassignment(
      oldAgentId,
      issueId,
      companyId
    );

    expect(cancelledCount).toBe(2); // Should cancel both for the specific issue

    // Verify that the correct deferred executions were cancelled
    const remainingDeferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, oldAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`
        )
      );
    
    expect(remainingDeferred.length).toBe(0); // All should be cancelled

    // Verify that the cancelled ones have the correct status
    const cancelledExecutions = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, oldAgentId),
          eq(agentWakeupRequests.status, "cancelled"),
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`
        )
      );
    
    expect(cancelledExecutions.length).toBe(2);
    expect(cancelledExecutions[0]?.error).toContain("Cancelled due to issue reassignment");
  });

  it("only cancels deferred executions for the specific issue", async () => {
    // Create deferred executions for the old agent related to different issues
    await db
      .insert(agentWakeupRequests)
      .values([
        {
          id: randomUUID(),
          companyId,
          agentId: oldAgentId,
          source: "automation",
          reason: "issue_commented", 
          payload: { issueId },
          status: "deferred_issue_execution",
          requestedAt: new Date(),
        },
        {
          id: randomUUID(),
          companyId,
          agentId: oldAgentId,
          source: "automation",
          reason: "issue_commented",
          payload: { issueId: randomUUID() }, // Different issue
          status: "deferred_issue_execution",
          requestedAt: new Date(),
        },
      ])
      .returning();

    // Verify both exist initially
    const allDeferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, oldAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          eq(agentWakeupRequests.companyId, companyId)
        )
      );
    
    expect(allDeferred.length).toBe(2);

    // Cancel deferred executions for reassignment (only for specific issue)
    const svc = issueServiceFactory(db);
    const cancelledCount = await svc.cancelDeferredExecutionsForAgentOnReassignment(
      oldAgentId,
      issueId,
      companyId
    );

    expect(cancelledCount).toBe(1); // Should cancel only the one for the specific issue

    // Verify that the one for the specific issue was cancelled
    const cancelledSpecific = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, oldAgentId),
          eq(agentWakeupRequests.status, "cancelled"),
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`
        )
      );
    
    expect(cancelledSpecific.length).toBe(1);

    // Verify that the one for the different issue is still deferred
    const remainingForOtherIssue = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, oldAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          eq(agentWakeupRequests.companyId, companyId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' != ${issueId}`
        )
      );
    
    expect(remainingForOtherIssue.length).toBe(1);
  });

  it("handles reassignment when no deferred executions exist for old agent", async () => {
    const svc = issueServiceFactory(db);
    const cancelledCount = await svc.cancelDeferredExecutionsForAgentOnReassignment(
      oldAgentId,
      issueId,
      companyId
    );

    expect(cancelledCount).toBe(0); // Should return 0 when nothing to cancel
  });
});