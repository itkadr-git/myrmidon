import express from "express";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Operator-hidden Access surface floor (`instance.access` in
 * PAPERCLIP_HIDDEN_SETTINGS): instance-admin user management routes reject
 * with a stable code while the rest of the access router stays untouched.
 * The floor throws before any data access, so a stub db suffices; the
 * unfloored happy paths are covered by the embedded-postgres access tests.
 */

const stubDb = {
  select: () => ({
    from: () => {
      const chain = {
        orderBy: async () => [] as unknown[],
        where: async () => [] as unknown[],
      };
      return chain;
    },
  }),
} as never;

const filteredDb = {
  select: () => ({
    from: (table: Record<string, unknown>) => {
      const isUsers = "email" in table && "name" in table;
      const isInstanceRoles = "userId" in table && "role" in table;
      const rows = isUsers
        ? [{ id: "user-1", name: "Alice", email: "alice@example.com", image: null }]
        : isInstanceRoles
          ? [{ userId: "instance-admin-1", role: "instance_admin" }]
          : [{ principalId: "user-1", status: "active", membershipRole: "owner" }];
      const chain = {
        orderBy: async () => rows,
        where: async () => rows,
      };
      return chain;
    },
  }),
} as never;

async function createApp(db = stubDb) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "instance-admin-1",
      source: "local_implicit",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    } as Express.Request["actor"];
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use(errorHandler);
  return app;
}

describe("operator-hidden access admin floor", () => {
  let app: express.Express;

  // The access router is a large module; import and build the app once so the
  // cost is not charged to the first test's timeout on slow CI runners.
  beforeAll(async () => {
    app = await createApp();
  }, 30_000);

  afterEach(() => {
    delete process.env.PAPERCLIP_HIDDEN_SETTINGS;
  });

  const attempts: Array<[string, () => request.Test]> = [
    ["promote", () => request(app).post("/api/admin/users/user-1/promote-instance-admin")],
    ["demote", () => request(app).post("/api/admin/users/user-1/demote-instance-admin")],
    [
      "company access write",
      () => request(app).put("/api/admin/users/user-1/company-access").send({ companyIds: [] }),
    ],
    ["user listing", () => request(app).get("/api/admin/users")],
    ["company access read", () => request(app).get("/api/admin/users/user-1/company-access")],
  ];

  it.each(attempts)(
    "floors the %s route when the operator hides the surface",
    async (_name, buildRequest) => {
      process.env.PAPERCLIP_HIDDEN_SETTINGS = "instance.access";

      const res = await buildRequest();

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "settings_operator_managed" });
    },
  );

  it("filters users by role and status", async () => {
    const filteredApp = await createApp(filteredDb);

    const res = await request(filteredApp).get("/api/admin/users?role=owner&status=active");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: "user-1", name: "Alice" }),
    ]);
  });

  it.each(["invalid", "agent"])("rejects invalid role filter %s", async (role) => {
    const res = await request(app).get(`/api/admin/users?role=${role}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Validation error");
  });

  it("rejects invalid status filter in the existing error format", async () => {
    const res = await request(app).get("/api/admin/users?status=disabled");

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Validation error");
  });

  it("keeps the routes reachable when the surface is not hidden", async () => {
    const res = await request(app).get("/api/admin/users");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([]);
  });
});
