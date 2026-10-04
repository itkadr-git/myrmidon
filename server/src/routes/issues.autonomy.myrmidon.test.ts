// myrmidon(1.6.2-AUTONOMY-MATRIX): tests for delete action class enforcement
// Tests that agent keys are properly restricted by the autonomy matrix when
// attempting DELETE operations

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDatabase, type TestDatabase } from "@paperclipai/db/test";
import { createTestApp, type TestAgent, type TestApp } from "@paperclipai/server/test";
import { dbAutonomyGate } from "../myrmidon/autonomy/gate.js";
import { sql } from "@paperclipai/db";

describe("Issues DELETE autonomy enforcement", () => {
  let db: TestDatabase;
  let app: TestApp;
  let agent: TestAgent;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createTestApp({ db });
    agent = await app.createAgent();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    // Setup default autonomy matrix allowing delete
    await dbAutonomyGate(db).setMatrix({
      version: 1,
      rules: [{
        role: agent.role,
        actionClass: "delete",
        verdict: "allowed"
      }],
      defaults: {
        delete: "allowed"
      }
    });
  });

  afterEach(async () => {
    // Clean up autonomy matrix
    await db.execute(sql`DELETE FROM instance_settings WHERE key = 'myrmidonAutonomy'`);
  });

  test("should allow DELETE operations when delete action is allowed", async () => {
    // Create an issue
    const issue = await app.createIssue({ agentId: agent.id });

    // Should be able to delete the issue
    const response = await app.request(
      `/api/issues/${issue.id}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${agent.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    // Expect either success (200/204) or not found (404) since issue might have child resources
    // The important thing is that it's not 403 forbidden
    expect(response.status).not.toBe(403);
  });

  test("should reject DELETE operations when delete action is forbidden", async () => {
    // Update autonomy matrix to forbid delete
    await dbAutonomyGate(db).setMatrix({
      version: 1,
      rules: [{
        role: agent.role,
        actionClass: "delete",
        verdict: "forbidden"
      }],
      defaults: {
        delete: "allowed"
      }
    });

    // Create an issue
    const issue = await app.createIssue({ agentId: agent.id });

    // Should NOT be able to delete the issue
    const response = await app.request(
      `/api/issues/${issue.id}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${agent.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("autonomy");
    expect(body.code).toBe("autonomy_forbidden");
  });

  test("should allow DELETE operations when delete action is set to approval_required", async () => {
    // Update autonomy matrix to require approval for delete
    await dbAutonomyGate(db).setMatrix({
      version: 1,
      rules: [{
        role: agent.role,
        actionClass: "delete",
        verdict: "approval_required"
      }],
      defaults: {
        delete: "allowed"
      }
    });

    // Create an issue
    const issue = await app.createIssue({ agentId: agent.id });

    // Currently, approval_required is treated as forbidden until approval workflow is implemented
    const response = await app.request(
      `/api/issues/${issue.id}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${agent.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    // As per current implementation, approval_required is treated as forbidden
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("autonomy");
    expect(body.code).toBe("autonomy_forbidden");
  });

  test("should allow DELETE operations for board users regardless of autonomy matrix", async () => {
    // Update autonomy matrix to forbid delete for agents
    await dbAutonomyGate(db).setMatrix({
      version: 1,
      rules: [{
        role: agent.role,
        actionClass: "delete",
        verdict: "forbidden"
      }],
      defaults: {
        delete: "forbidden"
      }
    });

    // Create an issue using the board
    const issue = await app.createIssue({ agentId: agent.id });

    // Board user should still be able to delete the issue
    const response = await app.request(
      `/api/issues/${issue.id}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${app.boardApiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    // Board users should be able to delete regardless of autonomy matrix
    expect(response.status).not.toBe(403);
  });

  test("should reject DELETE comment operations when delete action is forbidden", async () => {
    // Update autonomy matrix to forbid delete
    await dbAutonomyGate(db).setMatrix({
      version: 1,
      rules: [{
        role: agent.role,
        actionClass: "delete",
        verdict: "forbidden"
      }],
      defaults: {
        delete: "allowed"
      }
    });

    // Create an issue and a comment
    const issue = await app.createIssue({ agentId: agent.id });
    const comment = await app.createComment({
      issueId: issue.id,
      authorId: agent.id,
      content: "Test comment"
    });

    // Should NOT be able to delete the comment
    const response = await app.request(
      `/api/issues/${issue.id}/comments/${comment.id}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${agent.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("autonomy");
    expect(body.code).toBe("autonomy_forbidden");
  });

  test("should reject DELETE attachment operations when delete action is forbidden", async () => {
    // Update autonomy matrix to forbid delete
    await dbAutonomyGate(db).setMatrix({
      version: 1,
      rules: [{
        role: agent.role,
        actionClass: "delete",
        verdict: "forbidden"
      }],
      defaults: {
        delete: "allowed"
      }
    });

    // Create an issue and attachment
    const issue = await app.createIssue({ agentId: agent.id });
    const attachment = await app.createAttachment({
      issueId: issue.id,
      uploaderId: agent.id,
      fileName: "test.txt",
      contentType: "text/plain",
      size: 100
    });

    // Should NOT be able to delete the attachment
    const response = await app.request(
      `/api/attachments/${attachment.id}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${agent.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("autonomy");
    expect(body.code).toBe("autonomy_forbidden");
  });

  test("should reject DELETE inbox-archive operations when delete action is forbidden", async () => {
    // Update autonomy matrix to forbid delete
    await dbAutonomyGate(db).setMatrix({
      version: 1,
      rules: [{
        role: agent.role,
        actionClass: "delete",
        verdict: "forbidden"
      }],
      defaults: {
        delete: "allowed"
      }
    });

    // Create an inbox archive item
    const issue = await app.createIssue({ agentId: agent.id });

    // Should NOT be able to delete the inbox archive
    const response = await app.request(
      `/api/issues/${issue.id}/inbox-archive`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${agent.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("autonomy");
    expect(body.code).toBe("autonomy_forbidden");
  });

  test("should reject DELETE watchdog operations when delete action is forbidden", async () => {
    // Update autonomy matrix to forbid delete
    await dbAutonomyGate(db).setMatrix({
      version: 1,
      rules: [{
        role: agent.role,
        actionClass: "delete",
        verdict: "forbidden"
      }],
      defaults: {
        delete: "allowed"
      }
    });

    // Create an issue with watchdog
    const issue = await app.createIssue({ agentId: agent.id });

    // Should NOT be able to delete the watchdog
    const response = await app.request(
      `/api/issues/${issue.id}/watchdog`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${agent.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("autonomy");
    expect(body.code).toBe("autonomy_forbidden");
  });

  test("should reject DELETE work-products operations when delete action is forbidden", async () => {
    // Update autonomy matrix to forbid delete
    await dbAutonomyGate(db).setMatrix({
      version: 1,
      rules: [{
        role: agent.role,
        actionClass: "delete",
        verdict: "forbidden"
      }],
      defaults: {
        delete: "allowed"
      }
    });

    // Create an issue and work product
    const issue = await app.createIssue({ agentId: agent.id });
    const workProduct = await app.createWorkProduct({
      issueId: issue.id,
      title: "Test Work Product",
      resourceRef: { kind: "test", id: "test" }
    });

    // Should NOT be able to delete the work product
    const response = await app.request(
      `/api/work-products/${workProduct.id}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${agent.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("autonomy");
    expect(body.code).toBe("autonomy_forbidden");
  });

  test("should reject DELETE approval operations when delete action is forbidden", async () => {
    // Update autonomy matrix to forbid delete
    await dbAutonomyGate(db).setMatrix({
      version: 1,
      rules: [{
        role: agent.role,
        actionClass: "delete",
        verdict: "forbidden"
      }],
      defaults: {
        delete: "allowed"
      }
    });

    // Create an issue and approval
    const issue = await app.createIssue({ agentId: agent.id });
    const approval = await app.createIssueApproval({
      issueId: issue.id,
      title: "Test Approval",
      status: "pending"
    });

    // Should NOT be able to delete the approval
    const response = await app.request(
      `/api/issues/${issue.id}/approvals/${approval.id}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${agent.apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("autonomy");
    expect(body.code).toBe("autonomy_forbidden");
  });
});