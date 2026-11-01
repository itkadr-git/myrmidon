import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { usersRoutes } from "../routes/users.js";
import { auditRoutes } from "../routes/audit.js";

describe("users block API and audit routes", () => {
  let mockInsertedBlocks: any[] = [];
  let mockDeletedSessions: any[] = [];
  let mockRevokedKeys: any[] = [];
  let mockUpdatedMemberships: any[] = [];
  let mockAuditEntries: any[] = [];

  const mockDb = {
    insert: vi.fn((table: any) => ({
      values: vi.fn((vals: any) => {
        mockInsertedBlocks.push(vals);
        return {
          onConflictDoNothing: vi.fn().mockResolvedValue({}),
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
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(mockAuditEntries),
          })),
          then: vi.fn((resolve: (value: any[]) => void) =>
            resolve([{ id: "company-1" }]),
          ),
        })),
        orderBy: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(mockAuditEntries),
        })),
        then: vi.fn().mockResolvedValue([{ id: "company-1" }]),
      })),
    })),
  };

  // Mock logActivity
  vi.mock("../services/activity-log.js", () => ({
    logActivity: vi.fn(async (_db: any, input: any) => {
      mockAuditEntries.push({
        id: `audit-${mockAuditEntries.length + 1}`,
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

  const nonAdminActor = {
    type: "user",
    actorId: "regular-user-id",
    isInstanceAdmin: false,
    source: "session",
    memberships: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertedBlocks = [];
    mockDeletedSessions = [];
    mockRevokedKeys = [];
    mockUpdatedMemberships = [];
    mockAuditEntries = [];
  });

  describe("POST /api/users/:userId/block", () => {
    it("rejects non-admin users with 403 Forbidden", async () => {
      const app = createApp(nonAdminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "Violation" });

      expect(res.status).toBe(403);
    });

    it("rejects unauthenticated requests with 401 Unauthorized", async () => {
      const app = createApp(null);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "Violation" });

      expect([401, 403]).toContain(res.status);
    });

    it("rejects empty reason with 400 Bad Request", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "" });

      expect(res.status).toBe(400);
    });

    it("rejects whitespace-only reason with 400 Bad Request", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "    " });

      expect(res.status).toBe(400);
    });

    it("rejects missing reason with 400 Bad Request", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({});

      expect(res.status).toBe(400);
    });

    it("successfully blocks user when invoked by admin with a valid reason", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "Security incident: unauthorized access attempt" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        userId: "user-123",
        blocked: true,
        reason: "Security incident: unauthorized access attempt",
      });

      // Target user loses access: userBlocks insert, sessions deleted, API keys revoked
      expect(mockInsertedBlocks).toContainEqual(
        expect.objectContaining({ userId: "user-123", blockedByUserId: "admin-user-id" }),
      );
      expect(mockDeletedSessions.length).toBeGreaterThan(0);
      expect(mockRevokedKeys.length).toBeGreaterThan(0);

      // Audit entry is created with actor, target, and reason
      const blockAudit = mockAuditEntries.find(
        (e) => e.entityId === "user-123" && e.action === "user.blocked",
      );
      expect(blockAudit).toBeDefined();
      expect(blockAudit.actorId).toBe("admin-user-id");
      expect(blockAudit.entityId).toBe("user-123");
      expect(blockAudit.details.reason).toBe("Security incident: unauthorized access attempt");
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
      mockAuditEntries = [
        {
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
        },
      ];

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
