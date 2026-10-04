// myrmidon(1.6.2-AUTONOMY-MATRIX): tests for delete action class enforcement
// Tests that agent keys are properly restricted by the autonomy matrix when
// attempting DELETE operations on issues, comments, attachments, and inbox archives.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createTestApp } from "../../../test/test-app.js";
import { createTestDb } from "../../../test/test-db.js";
import { dbAutonomyStore } from "../myrmidon/autonomy/store.js";
import type { Db } from "@paperclipai/db";

describe("Autonomy Matrix DELETE Enforcement in Issues Routes", () => {
  let db: Db;
  let app;
  let testAgentId: string;
  let testCompanyId: string;
  let agentApiKey: string;

  beforeAll(async () => {
    ({ db, app } = await createTestApp());
  });

  afterAll(async () => {
    if (db) {
      await db.$client().destroy();
    }
  });

  beforeEach(async () => {
    // Create a test company and agent
    testCompanyId = randomUUID();
    testAgentId = randomUUID();
    
    // Insert test agent with API key
    const apiKey = `pcp_test_${randomUUID().replace(/-/g, "")}`;
    agentApiKey = apiKey;
    
    await db.insert(require("@paperclipai/db").agents).values({
      id: testAgentId,
      companyId: testCompanyId,
      name: "Test Agent",
      adapterType: "test-adapter",
      role: "test-role",
      status: "active"
    });
    
    await db.insert(require("@paperclipai/db").agentApiKeys).values({
      id: randomUUID(),
      agentId: testAgentId,
      name: "Test Key",
      apiKeyHash: require("node:crypto").createHash("sha256").update(apiKey).digest("hex"),
      scope: "full_access",
      revokedAt: null
    });
  });

  afterEach(async () => {
    // Clean up test data
    await db.delete(require("@paperclipai/db").agentApiKeys).where(
      require("drizzle-orm").eq(require("@paperclipai/db").agentApiKeys.agentId, testAgentId)
    );
    await db.delete(require("@paperclipai/db").agents).where(
      require("drizzle-orm").eq(require("@paperclipai/db").agents.id, testAgentId)
    );
  });

  describe("DELETE /issues/:id", () => {
    let testIssueId: string;

    beforeEach(async () => {
      testIssueId = randomUUID();
      await db.insert(require("@paperclipai/db").issues).values({
        id: testIssueId,
        companyId: testCompanyId,
        title: "Test Issue",
        status: "todo",
        assigneeAgentId: testAgentId,
        origin: "test"
      });
    });

    afterEach(async () => {
      await db.delete(require("@paperclipai/db").issues).where(
        require("drizzle-orm").eq(require("@paperclipai/db").issues.id, testIssueId)
      );
    });

    it("should deny DELETE with 403 when role forbids delete action", async () => {
      // Configure matrix to forbid delete
      const matrix = await dbAutonomyStore(db).read(testCompanyId);
      await dbAutonomyStore(db).update(testCompanyId, {
        ...matrix.matrix,
        rules: [{ role: "test-role", actionClass: "delete", verdict: "forbidden" }],
        version: matrix.matrix.version + 1
      });

      const response = await request(app)
        .delete(`/api/issues/${testIssueId}`)
        .set("Authorization", `Bearer ${agentApiKey}`)
        .expect(403);

      expect(response.body.code).toBe("autonomy_forbidden");
      expect(response.body.actionClass).toBe("delete");
    });

    it("should allow DELETE when role permits delete action", async () => {
      // Configure matrix to allow delete
      const matrix = await dbAutonomyStore(db).read(testCompanyId);
      await dbAutonomyStore(db).update(testCompanyId, {
        ...matrix.matrix,
        rules: [{ role: "test-role", actionClass: "delete", verdict: "allowed" }],
        version: matrix.matrix.version + 1
      });

      // This test will likely fail due to other constraints, but the autonomy check should pass
      const response = await request(app)
        .delete(`/api/issues/${testIssueId}`)
        .set("Authorization", `Bearer ${agentApiKey}`);
      
      // The key point is that we shouldn't get autonomy_forbidden error
      expect(response.body.code).not.toBe("autonomy_forbidden");
    });
  });

  describe("DELETE /issues/:id/comments/:commentId", () => {
    let testIssueId: string;
    let testCommentId: string;

    beforeEach(async () => {
      testIssueId = randomUUID();
      testCommentId = randomUUID();
      
      await db.insert(require("@paperclipai/db").issues).values({
        id: testIssueId,
        companyId: testCompanyId,
        title: "Test Issue",
        status: "todo",
        assigneeAgentId: testAgentId,
        origin: "test"
      });
      
      await db.insert(require("@paperclipai/db").issueComments).values({
        id: testCommentId,
        issueId: testIssueId,
        companyId: testCompanyId,
        body: "Test comment",
        authorAgentId: testAgentId
      });
    });

    afterEach(async () => {
      await db.delete(require("@paperclipai/db").issueComments).where(
        require("drizzle-orm").eq(require("@paperclipai/db").issueComments.id, testCommentId)
      );
      await db.delete(require("@paperclipai/db").issues).where(
        require("drizzle-orm").eq(require("@paperclipai/db").issues.id, testIssueId)
      );
    });

    it("should deny DELETE with 403 when role forbids delete action", async () => {
      // Configure matrix to forbid delete
      const matrix = await dbAutonomyStore(db).read(testCompanyId);
      await dbAutonomyStore(db).update(testCompanyId, {
        ...matrix.matrix,
        rules: [{ role: "test-role", actionClass: "delete", verdict: "forbidden" }],
        version: matrix.matrix.version + 1
      });

      const response = await request(app)
        .delete(`/api/issues/${testIssueId}/comments/${testCommentId}`)
        .set("Authorization", `Bearer ${agentApiKey}`)
        .expect(403);

      expect(response.body.code).toBe("autonomy_forbidden");
      expect(response.body.actionClass).toBe("delete");
    });
  });

  describe("DELETE /attachments/:attachmentId", () => {
    let testIssueId: string;
    let testAttachmentId: string;

    beforeEach(async () => {
      testIssueId = randomUUID();
      testAttachmentId = randomUUID();
      
      await db.insert(require("@paperclipai/db").issues).values({
        id: testIssueId,
        companyId: testCompanyId,
        title: "Test Issue",
        status: "todo",
        assigneeAgentId: testAgentId,
        origin: "test"
      });
      
      await db.insert(require("@paperclipai/db").issueAttachments).values({
        id: testAttachmentId,
        issueId: testIssueId,
        companyId: testCompanyId,
        fileName: "test.txt",
        mimeType: "text/plain",
        fileSize: 100,
        objectKey: "test-key",
        provider: "local"
      });
    });

    afterEach(async () => {
      await db.delete(require("@paperclipai/db").issueAttachments).where(
        require("drizzle-orm").eq(require("@paperclipai/db").issueAttachments.id, testAttachmentId)
      );
      await db.delete(require("@paperclipai/db").issues).where(
        require("drizzle-orm").eq(require("@paperclipai/db").issues.id, testIssueId)
      );
    });

    it("should deny DELETE with 403 when role forbids delete action", async () => {
      // Configure matrix to forbid delete
      const matrix = await dbAutonomyStore(db).read(testCompanyId);
      await dbAutonomyStore(db).update(testCompanyId, {
        ...matrix.matrix,
        rules: [{ role: "test-role", actionClass: "delete", verdict: "forbidden" }],
        version: matrix.matrix.version + 1
      });

      const response = await request(app)
        .delete(`/api/attachments/${testAttachmentId}`)
        .set("Authorization", `Bearer ${agentApiKey}`)
        .expect(403);

      expect(response.body.code).toBe("autonomy_forbidden");
      expect(response.body.actionClass).toBe("delete");
    });
  });

  describe("DELETE /issues/:id/inbox-archive", () => {
    let testIssueId: string;

    beforeEach(async () => {
      testIssueId = randomUUID();
      await db.insert(require("@paperclipai/db").issues).values({
        id: testIssueId,
        companyId: testCompanyId,
        title: "Test Issue",
        status: "todo",
        assigneeAgentId: testAgentId,
        origin: "test"
      });
    });

    afterEach(async () => {
      await db.delete(require("@paperclipai/db").issues).where(
        require("drizzle-orm").eq(require("@paperclipai/db").issues.id, testIssueId)
      );
    });

    it("should deny DELETE with 403 when role forbids delete action", async () => {
      // Configure matrix to forbid delete
      const matrix = await dbAutonomyStore(db).read(testCompanyId);
      await dbAutonomyStore(db).update(testCompanyId, {
        ...matrix.matrix,
        rules: [{ role: "test-role", actionClass: "delete", verdict: "forbidden" }],
        version: matrix.matrix.version + 1
      });

      const response = await request(app)
        .delete(`/api/issues/${testIssueId}/inbox-archive`)
        .set("Authorization", `Bearer ${agentApiKey}`)
        .send({})
        .expect(403);

      expect(response.body.code).toBe("autonomy_forbidden");
      expect(response.body.actionClass).toBe("delete");
    });
  });
});
