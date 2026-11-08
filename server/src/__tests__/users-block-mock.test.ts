import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { usersRoutes } from "../routes/users.js";
import { auditRoutes } from "../routes/audit.js";
import { userBlocks } from "@myrmidon/db";

const testState = vi.hoisted(() => ({
  auditEntries: [] as any[],
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async (_db: any, input: any) => {
    testState.auditEntries.push({
      id: `audit-${testState.auditEntries.length + 1}`,
      companyId: input.companyId,
      actorId: input.actorId,
      actorType: input.actorType,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: input.details,
      createdAt: new Date(),
    });
  }),
}));

describe("users block API and audit routes", () => {
  let mockInsertedBlocks: any[] = [];
  let mockDeletedSessions: any[] = [];
  let mockRevokedKeys: any[] = [];
  let mockUpdatedMemberships: any[] = [];
  const mockAuditEntries = testState.auditEntries;

  const mockDb = {
    insert: vi.fn((table: any) => ({
      values: vi.fn((vals: any) => {
        if (table === userBlocks) {
          mockInsertedBlocks.push(vals);
        }
        return {
          onConflictDoNothing: vi.fn().mockResolvedValue({}),
          returning: vi.fn().mockResolvedValue([{ id: "company-1" }]),
        };
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((setVals: any) => ({
        where: vi.fn().mockImplementation((condition: any) => {
          mockRevokedKeys.push(setVals);
          mockUpdatedMemberships.push(setVals);
          return Promise.resolve([]);
        }),
      })),
    })),
    delete: vi.fn((table: any) => ({
      where: vi.fn().mockImplementation(() => {
        const deleted = [{ id: "session-1" }, { id: "session-2" }];
        mockDeletedSessions.push(...deleted);
        return {
          returning: vi.fn().mockResolvedValue(deleted),
        };
      }),
    })),
    select: vi.fn(() => {
      const query: any = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        for: vi.fn(() => query),
        limit: vi.fn().mockImplementation(() => Promise.resolve(mockAuditEntries)),
        then: vi.fn((resolve: (value: any[]) => void) =>
          resolve([{ id: "company-1", general: {} }]),
        ),
      };
      return query;
    }),
    transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockDb)),
  };

  function createApp(actor: any) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", usersRoutes(mockDb as any));
    app.use("/api", auditRoutes(mockDb as any));
    app.use(errorHandler);
    return app;
  }

  const adminActor = {
    type: "user",
    actorId: "admin-user-id",
    isInstanceAdmin: true,
    source: "session",
  };

  const companyAdminActor = {
    type: "board",
    userId: "admin-user-id",
    isInstanceAdmin: true,
    companyIds: ["company-1"],
  };

  const nonAdminActor = {
    type: "user",
    actorId: "regular-user-id",
    isInstanceAdmin: false,
    source: "session",
    memberships: [],
  };

  beforeEach(() => {
    mockInsertedBlocks = [];
    mockDeletedSessions = [];
    mockRevokedKeys = [];
    mockUpdatedMemberships = [];
    testState.auditEntries.length = 0;
    vi.clearAllMocks();
  });

  describe("POST /api/users/:userId/block", () => {
    it("rejects unauthenticated requests with 401 Unauthorized", async () => {
      const app = createApp(null);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "Policy violation" });

      expect(res.status).toBe(401);
    });

    it("rejects non-admin users with 403 Forbidden", async () => {
      const app = createApp(nonAdminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "Policy violation" });

      expect(res.status).toBe(403);
    });

    it("rejects when reason is empty with 400 Bad Request", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("reason");
    });

    it("rejects whitespace-only reason with 400 Bad Request", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "    " });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("reason");
    });

    it("rejects when reason is missing with 400 Bad Request", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("reason");
    });

    it("rejects when an admin tries to block themselves with 409 Conflict", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/admin-user-id/block")
        .send({ reason: "Self block attempt" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("cannot block yourself");
    });

    it("successfully blocks a user and records audit log", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "Suspicious behavior" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        userId: "user-123",
        blocked: true,
        reason: "Suspicious behavior",
        sessionsClosed: 2,
      });

      expect(mockInsertedBlocks.length).toBe(1);
      expect(mockInsertedBlocks[0].userId).toBe("user-123");
      expect(mockInsertedBlocks[0].blockedByUserId).toBe("admin-user-id");
      expect(mockInsertedBlocks[0].reason).toBe("Suspicious behavior");

      expect(testState.auditEntries.length).toBe(1);
      const blockAudit = testState.auditEntries[0];
      expect(blockAudit.action).toBe("user.blocked");
      expect(blockAudit.actorId).toBe("admin-user-id");
      expect(blockAudit.entityId).toBe("user-123");
      expect(blockAudit.details.reason).toBe("Suspicious behavior");
      expect(blockAudit.details.sessionsClosed).toBe(2);
      expect(blockAudit.details.actor).toBe("admin-user-id");
      expect(blockAudit.details.target).toBe("user-123");
    });
  });

  describe("PATCH /api/users/:userId/block (OPE-12116)", () => {
    it("rejects unauthenticated requests with 401 Unauthorized", async () => {
      const app = createApp(null);
      const res = await request(app)
        .patch("/api/users/user-123/block")
        .send({ blocked: true });

      expect(res.status).toBe(401);
    });

    it("rejects non-admin users with 403 Forbidden", async () => {
      const app = createApp(nonAdminActor);
      const res = await request(app)
        .patch("/api/users/user-123/block")
        .send({ blocked: true });

      expect(res.status).toBe(403);
    });

    it("rejects self-blocking with 409 Conflict", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .patch("/api/users/admin-user-id/block")
        .send({ blocked: true });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("cannot block yourself");
    });

    it("successfully blocks a user with PATCH", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .patch("/api/users/user-123/block")
        .send({ blocked: true, reason: "Abusive actions" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        userId: "user-123",
        blocked: true,
        reason: "Abusive actions",
        sessionsClosed: 2,
      });

      expect(testState.auditEntries.length).toBe(1);
      const blockAudit = testState.auditEntries[0];
      expect(blockAudit.action).toBe("user.blocked");
      expect(blockAudit.entityId).toBe("user-123");
    });

    it("successfully unblocks a user with PATCH", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .patch("/api/users/user-123/block")
        .send({ blocked: false });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        userId: "user-123",
        blocked: false,
        sessionsClosed: 0,
      });

      expect(testState.auditEntries.length).toBe(1);
      const unblockAudit = testState.auditEntries[0];
      expect(unblockAudit.action).toBe("user.unblocked");
      expect(unblockAudit.entityId).toBe("user-123");
    });
  });

  describe("POST /api/users/:userId/reset-password (OPE-12116)", () => {
    it("rejects unauthenticated requests with 401 Unauthorized", async () => {
      const app = createApp(null);
      const res = await request(app)
        .post("/api/users/user-123/reset-password");

      expect(res.status).toBe(401);
    });

    it("rejects non-admin users with 403 Forbidden", async () => {
      const app = createApp(nonAdminActor);
      const res = await request(app)
        .post("/api/users/user-123/reset-password");

      expect(res.status).toBe(403);
    });

    it("issues a one-time password reset token without SMTP", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/reset-password");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.userId).toBe("user-123");
      expect(typeof res.body.token).toBe("string");
      expect(res.body.token.length).toBeGreaterThan(10);
      expect(res.body.resetToken).toBe(res.body.token);

      expect(testState.auditEntries.length).toBe(1);
      const audit = testState.auditEntries[0];
      expect(audit.action).toBe("user.password_reset");
      expect(audit.entityId).toBe("user-123");
    });
  });

  describe("POST /api/companies/:companyId/users/:userId/block", () => {
    it("rejects non-admin users with 403 Forbidden", async () => {
      const app = createApp(nonAdminActor);
      const res = await request(app)
        .post("/api/companies/company-1/users/user-123/block")
        .send({ reason: "Company policy violation" });

      expect(res.status).toBe(403);
    });

    it("rejects when reason is empty with 400 Bad Request", async () => {
      const app = createApp(companyAdminActor);
      const res = await request(app)
        .post("/api/companies/company-1/users/user-123/block")
        .send({ reason: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("reason");
    });

    it("rejects when an admin tries to block themselves within company with 409 Conflict", async () => {
      const app = createApp(companyAdminActor);
      const res = await request(app)
        .post("/api/companies/company-1/users/admin-user-id/block")
        .send({ reason: "Self block" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("cannot block yourself");
    });

    it("successfully blocks user within company and records audit log", async () => {
      const app = createApp(companyAdminActor);
      const res = await request(app)
        .post("/api/companies/company-1/users/user-123/block")
        .send({ reason: "Company violation" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        companyId: "company-1",
        userId: "user-123",
        blocked: true,
        reason: "Company violation",
        sessionsClosed: 2,
      });

      expect(testState.auditEntries.length).toBe(1);
      const blockAudit = testState.auditEntries[0];
      expect(blockAudit.action).toBe("user.blocked");
      expect(blockAudit.companyId).toBe("company-1");
      expect(blockAudit.actorId).toBe("admin-user-id");
      expect(blockAudit.entityId).toBe("user-123");
      expect(blockAudit.details.reason).toBe("Company violation");
      expect(blockAudit.details.sessionsClosed).toBe(2);
      expect(blockAudit.details.actor).toBe("admin-user-id");
      expect(blockAudit.details.target).toBe("user-123");
    });
  });

  describe("Audit routes GET /api/audit", () => {
    it("rejects non-admin users with 403 Forbidden", async () => {
      const app = createApp(nonAdminActor);
      const res = await request(app).get("/api/audit");

      expect(res.status).toBe(403);
    });

    it("returns audit records containing actor, target, and reason for admins", async () => {
      mockAuditEntries.splice(0, mockAuditEntries.length, {
        id: "audit-1",
        companyId: "company-1",
        actorId: "admin-user-id",
        actorType: "user",
        action: "user.blocked",
        entityType: "user",
        entityId: "user-123",
        details: {
          actor: "admin-user-id",
          target: "user-123",
          reason: "Violation of terms",
        },
        createdAt: new Date(),
      });

      const app = createApp(adminActor);
      const res = await request(app).get("/api/audit");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0]).toMatchObject({
        actor: "admin-user-id",
        target: "user-123",
        reason: "Violation of terms",
        action: "user.blocked",
      });
    });
  });
});
