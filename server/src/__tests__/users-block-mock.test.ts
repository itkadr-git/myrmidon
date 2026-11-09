import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { usersRoutes } from "../routes/users.js";
import { auditRoutes } from "../routes/audit.js";
import {
  activityLog,
  authSessions,
  authUsers,
  companies,
  companyMemberships,
  instanceSettings,
  userBlocks,
} from "@myrmidon/db";

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

  /**
   * A table-aware mock of the drizzle builder surface the block routes use.
   * Real call shapes reproduced here (server/src/myrmidon/users-admin-a):
   *   - insert(userBlocks).values(...).onConflictDoNothing()          (service + in-tx re-insert)
   *   - insert(instanceSettings).values(...).onConflictDoNothing()   (singleton bootstrap)
   *   - update(boardApiKeys).set(...).where(...)                     (API-key revoke)
   *   - delete(authSessions).where(...).returning(...)               (session close)
   *   - select().from(authUsers).where(...)                          (getUser by id)
   *   - select().from(instanceSettings).where(...).for("update")     (blocklist row)
   *   - select().from(companyMemberships).where(...)                 (getMembership)
   *   - select({id}).from(companies)                                 (audit target companies)
   *   - select(...).from(activityLog)...limit(...)                   (audit listing)
   */
  const mockDb = {
    insert: vi.fn((table: any) => ({
      values: vi.fn((vals: any) => {
        if (table === userBlocks) {
          mockInsertedBlocks.push(vals);
        }
        const builder: any = {
          onConflictDoNothing: vi.fn().mockResolvedValue({}),
          returning: vi.fn().mockResolvedValue([{ id: "company-1" }]),
        };
        if (table === instanceSettings) {
          // setBlockedUser bootstraps the singleton row; it never reads values back.
          return { onConflictDoNothing: builder.onConflictDoNothing };
        }
        return builder;
      }),
    })),
    update: vi.fn((_table: any) => ({
      set: vi.fn((setVals: any) => ({
        where: vi.fn().mockImplementation(() => {
          mockRevokedKeys.push(setVals);
          mockUpdatedMemberships.push(setVals);
          return Promise.resolve([]);
        }),
      })),
    })),
    delete: vi.fn((table: any) => ({
      where: vi.fn().mockImplementation(() => {
        const deleted =
          table === authSessions
            ? [{ id: "session-1" }, { id: "session-2" }]
            : [{ id: "row-1" }];
        mockDeletedSessions.push(...deleted);
        return {
          returning: vi.fn().mockResolvedValue(deleted),
        };
      }),
    })),
    select: vi.fn(() => {
      const query: any = {
        from: vi.fn((table: any) => {
          query.__table = table;
          return query;
        }),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        for: vi.fn(() => query),
        limit: vi.fn().mockImplementation(() => {
          if (query.__table === activityLog) {
            return Promise.resolve(mockAuditEntries);
          }
          return Promise.resolve([]);
        }),
        then: (onFulfilled: (value: any[]) => any, onRejected?: (reason: unknown) => any) => {
          let rows: any[];
          if (query.__table === instanceSettings) {
            // readStoredBlockedUsers: the singleton row (or none).
            rows = [{ id: "settings-1", general: {} }];
          } else if (query.__table === companyMemberships) {
            // getMembership maps rows[0] ?? null: no membership by default.
            rows = [];
          } else if (query.__table === authUsers) {
            // getUser targets one user id; the mock resolves the target row.
            rows = [
              {
                id: "user-123",
                name: "User",
                email: "user@example.com",
                createdAt: new Date(),
              },
            ];
          } else {
            // auditUserBlock: the company rows to fan audit entries over.
            rows = [{ id: "company-1", general: {} }];
          }
          return Promise.resolve(rows).then(onFulfilled, onRejected);
        },
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

  // Session user actor passes the instance assertAdmin guard (type "user" +
  // isInstanceAdmin). Board actor passes both the instance guard and the
  // company route's assertCompanyAccess + isInstanceAdmin path.
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

  // Non-admin board actor: instance routes reject with 403 (assertAdmin), the
  // company route with 403 (assertCompanyAccess: companyIds not listed).
  const nonAdminActor = {
    type: "board",
    userId: "regular-user-id",
    isInstanceAdmin: false,
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
      // The shared error handler answers zod failures with the constant
      // "Validation error" message; the field lives in the issue paths.
      expect(res.body.error).toBe("Validation error");
      const issuePaths = JSON.stringify(res.body.details);
      expect(issuePaths).toContain("reason");
    });

    it("rejects whitespace-only reason with 400 Bad Request", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({ reason: "    " });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(JSON.stringify(res.body.details)).toContain("reason");
    });

    it("rejects when reason is missing with 400 Bad Request", async () => {
      const app = createApp(adminActor);
      const res = await request(app)
        .post("/api/users/user-123/block")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      expect(JSON.stringify(res.body.details)).toContain("reason");
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

      // setUserBlocked inserts into userBlocks twice by design: the service
      // guard write and the idempotent re-insert inside the settings
      // transaction. The route must not add a third write.
      expect(mockInsertedBlocks.length).toBe(2);
      expect(mockInsertedBlocks[0].userId).toBe("user-123");
      expect(mockInsertedBlocks[0].blockedByUserId).toBe("admin-user-id");
      expect(mockInsertedBlocks[1]).toEqual(mockInsertedBlocks[0]);

      expect(mockDeletedSessions.length).toBe(2);
      expect(mockRevokedKeys.length).toBeGreaterThan(0);

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
      expect(res.body.passwordSetLink).toContain(res.body.token);

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
      // Same validate() + errorHandler contract as the instance route.
      expect(res.body.error).toBe("Validation error");
      expect(JSON.stringify(res.body.details)).toContain("reason");
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
