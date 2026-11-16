import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, companyTransferRuns, createDb, issues, projects } from "@myrmidon/db";

import { companyRoutes } from "../routes/companies.js";
import { companyService } from "../services/companies.js";
import { errorHandler } from "../middleware/index.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("company migration dry run", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("migration-read-only-");
    db = createDb(temporary.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "migration-read-only-"));
  }, 90_000);
  afterAll(async () => {
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("runs the real operator route without database, storage, or audit writes", async () => {
    const [source] = await db.insert(companies).values({ name: "Migration fixture", issuePrefix: "MIG" }).returning();
    const [worker] = await db.insert(agents).values({ companyId: source!.id, name: "Migration worker" }).returning();
    const [project] = await db.insert(projects).values({ companyId: source!.id, name: "Migration project" }).returning();
    await db.insert(issues).values({
      companyId: source!.id, projectId: project!.id, assigneeAgentId: worker!.id, title: "Migration task",
    });
    const storage = createStorageService(createLocalDiskStorageProvider(root));
    const insert = vi.spyOn(db, "insert");
    const update = vi.spyOn(db, "update");
    const remove = vi.spyOn(db, "delete");
    const beforeCompanies = await db.select().from(companies);
    const beforeAgents = await db.select().from(agents);
    const beforeProjects = await db.select().from(projects);
    const beforeIssues = await db.select().from(issues);
    const beforeRuns = await db.select().from(companyTransferRuns);
    const beforeAudit = await db.select().from(activityLog);
    const filesBefore = await readdir(root, { recursive: true });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, storage));
    app.use(errorHandler);
    const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Destination" },
      export: { include: { projects: true, issues: true } },
    });
    expect(response.status).toBe(200);
    expect(response.body.dryRun).toBe(true);
    expect(response.body.validation.errors).toEqual([]);
    expect(response.body.counts).toMatchObject({ agents: 1, projects: 1, issues: 1 });

    const existingTarget = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "existing_company", companyId: source!.id },
    });
    expect(existingTarget.status).toBe(400);

    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(agents)).toEqual(beforeAgents);
    expect(await db.select().from(projects)).toEqual(beforeProjects);
    expect(await db.select().from(issues)).toEqual(beforeIssues);
    expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
    expect(await db.select().from(activityLog)).toEqual(beforeAudit);
    expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
    insert.mockRestore(); update.mockRestore(); remove.mockRestore();
  });

  it("reports secret bindings without revealing source environment values", async () => {
    const [source] = await db.insert(companies).values({ name: "Secret fixture", issuePrefix: "MSC" }).returning();
    await db.insert(agents).values({
      companyId: source!.id,
      name: "Secret worker",
      adapterConfig: { env: { API_KEY: { type: "plain", value: "migration-secret-canary" } } },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Secret destination" },
    });
    expect(response.status).toBe(200);
    expect(response.body.validation.secretBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "API_KEY" }),
    ]));
    expect(JSON.stringify(response.body)).not.toContain("migration-secret-canary");
  });

  it("rejects migration dry runs from agents without writing to the database", async () => {
    const [source] = await db.insert(companies).values({ name: "Agent access fixture", issuePrefix: "MAC" }).returning();
    const [worker] = await db.insert(agents).values({ companyId: source!.id, name: "Access worker" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: worker!.id, companyId: source!.id, source: "agent_key" };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);
    const insert = vi.spyOn(db, "insert");
    const update = vi.spyOn(db, "update");
    const remove = vi.spyOn(db, "delete");
    try {
      const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
        target: { mode: "new_company", newCompanyName: "Unauthorized destination" },
      });
      expect(response.status).toBe(403);
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      insert.mockRestore(); update.mockRestore(); remove.mockRestore();
    }
  });

  it("rejects a board user without access to the source company without side effects", async () => {
    const [source] = await db.insert(companies).values({ name: "Private migration source", issuePrefix: "MPS" }).returning();
    const [other] = await db.insert(companies).values({ name: "Other migration company", issuePrefix: "MOC" }).returning();
    const beforeCompanies = await db.select().from(companies);
    const beforeAudit = await db.select().from(activityLog);
    const filesBefore = await readdir(root, { recursive: true });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "other-user", source: "session", companyIds: [other!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);
    const insert = vi.spyOn(db, "insert");
    const update = vi.spyOn(db, "update");
    const remove = vi.spyOn(db, "delete");
    try {
      const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
        target: { mode: "new_company", newCompanyName: "Unauthorized destination" },
      });
      expect(response.status).toBe(403);
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(await db.select().from(companies)).toEqual(beforeCompanies);
      expect(await db.select().from(activityLog)).toEqual(beforeAudit);
      expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
    } finally {
      insert.mockRestore(); update.mockRestore(); remove.mockRestore();
    }
  });

  it("rejects an unconfirmed apply without database, storage, or audit writes", async () => {
    const [source] = await db.insert(companies).values({ name: "Confirmation fixture", issuePrefix: "MCF" }).returning();
    const beforeCompanies = await db.select().from(companies);
    const beforeAudit = await db.select().from(activityLog);
    const filesBefore = await readdir(root, { recursive: true });
    const insert = vi.spyOn(db, "insert");
    const update = vi.spyOn(db, "update");
    const remove = vi.spyOn(db, "delete");
    try {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
        next();
      });
      app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
      app.use(errorHandler);
      const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
        target: { mode: "new_company", newCompanyName: "Unconfirmed destination" },
        dryRun: false,
        apply: true,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(await db.select().from(companies)).toEqual(beforeCompanies);
      expect(await db.select().from(activityLog)).toEqual(beforeAudit);
      expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
    } finally {
      insert.mockRestore(); update.mockRestore(); remove.mockRestore();
    }
  });

  it("rejects a confirmed apply until recovery is implemented, without side effects", async () => {
    const [source] = await db.insert(companies).values({ name: "Apply safety fixture", issuePrefix: "MSF" }).returning();
    const storage = createStorageService(createLocalDiskStorageProvider(root));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, storage));
    app.use(errorHandler);

    const beforeCompanies = await db.select().from(companies);
    const beforeRuns = await db.select().from(companyTransferRuns);
    const beforeAudit = await db.select().from(activityLog);
    const filesBefore = await readdir(root, { recursive: true });
    const insert = vi.spyOn(db, "insert");
    const update = vi.spyOn(db, "update");
    const remove = vi.spyOn(db, "delete");
    try {
      const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
        target: { mode: "new_company", newCompanyName: "Forbidden destination" },
        dryRun: false, apply: true, confirm: "approved pilot",
      });
      expect(response.status).toBe(400);
      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(await db.select().from(companies)).toEqual(beforeCompanies);
      expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
      expect(await db.select().from(activityLog)).toEqual(beforeAudit);
      expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
    } finally {
      insert.mockRestore(); update.mockRestore(); remove.mockRestore();
    }
  });

  it("atomically associates a created company with an applying transfer run", async () => {
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "applying", actorKey: "migration-test",
      idempotencyKey: "provenance-success", containerRef: {},
    }).returning();
    const company = await companyService(db).create({ name: "Provenance destination" }, { transferRunId: run!.id });
    const saved = (await db.select().from(companyTransferRuns)).find((entry) => entry.id === run!.id);
    expect(saved?.companyId).toBe(company.id);
  });

  it("rolls back company creation when its transfer run cannot be claimed", async () => {
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "failed", actorKey: "migration-test",
      idempotencyKey: "provenance-rejected", containerRef: {},
    }).returning();
    await expect(companyService(db).create({ name: "Unclaimable destination" }, { transferRunId: run!.id }))
      .rejects.toThrow("Transfer run cannot claim a new company");
    expect((await db.select().from(companies)).some((company) => company.name === "Unclaimable destination")).toBe(false);
    const saved = (await db.select().from(companyTransferRuns)).find((entry) => entry.id === run!.id);
    expect(saved?.companyId).toBeNull();
  });

  it("records destination provenance before a failure creating its owner membership", async () => {
    const [source] = await db.insert(companies).values({ name: "Interrupted fixture", issuePrefix: "MIF" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const originalInsert = db.insert.bind(db);
    const insert = vi.spyOn(db, "insert").mockImplementation(((table: Parameters<typeof db.insert>[0]) => {
      if (table === companyMemberships) throw new Error("injected membership failure");
      return originalInsert(table);
    }) as typeof db.insert);
    try {
      const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
        target: { mode: "new_company", newCompanyName: "Interrupted destination" },
        dryRun: false, apply: true, confirm: "approved pilot",
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    } finally {
      insert.mockRestore();
    }

    const destination = (await db.select().from(companies)).find((company) => company.name === "Interrupted destination");
    expect(destination).toBeDefined();
    const run = (await db.select().from(companyTransferRuns)).find((entry) => entry.companyId === destination!.id);
    expect(run).toBeDefined();
    expect(run!.status).toBe("failed");
    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${run!.id}/rollback`)
      .send({ confirm: "recover interrupted pilot" });
    expect(rollback.status).toBe(200);
    const remaining = await db.select().from(companies);
    expect(remaining.some((company) => company.id === source!.id)).toBe(true);
    expect(remaining.some((company) => company.id === destination!.id && company.status !== "archived")).toBe(false);
  });

  it("requires confirmation for rollback and removes only the migrated company", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback fixture", issuePrefix: "MRB" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Rollback destination" },
      dryRun: false,
      apply: true,
      confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    expect(applied.body.runId).toEqual(expect.any(String));
    const beforeRollback = await db.select().from(companies);
    expect(beforeRollback.some((company) => company.name === "Rollback destination")).toBe(true);

    const endpoint = `/api/companies/${source!.id}/migrations/${applied.body.runId}/rollback`;
    const unconfirmed = await request(app).post(endpoint).send({});
    expect(unconfirmed.status).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(companies)).toEqual(beforeRollback);

    const rolledBack = await request(app).post(endpoint).send({ confirm: "rollback pilot" });
    expect(rolledBack.status).toBe(200);
    const afterRollback = await db.select().from(companies);
    expect(afterRollback.find((company) => company.id === source!.id)).toEqual(
      beforeRollback.find((company) => company.id === source!.id),
    );
    expect(afterRollback.filter((company) => company.name === "Rollback destination" && company.status !== "archived")).toHaveLength(0);
  });

  it("refuses rollback when a migrated agent was modified after import", async () => {
    const [source] = await db.insert(companies).values({ name: "Modified rollback source", issuePrefix: "MMD" }).returning();
    await db.insert(agents).values({ companyId: source!.id, name: "Original worker" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Modified rollback destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const destination = (await db.select().from(companies)).find((company) => company.name === "Modified rollback destination")!;
    const copied = (await db.select().from(agents)).find((agent) => agent.companyId === destination.id)!;
    const { eq } = await import("drizzle-orm");
    await db.update(agents).set({ name: "Modified worker", updatedAt: new Date(copied.createdAt.getTime() + 60_000) })
      .where(eq(agents.id, copied.id));
    const beforeCompanies = await db.select().from(companies);
    const beforeAgents = await db.select().from(agents);

    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${applied.body.runId}/rollback`)
      .send({ confirm: "rollback pilot" });
    expect(rollback.status).toBe(409);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(agents)).toEqual(beforeAgents);
  });

  it("rejects rollback of a migration through a different source company", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback source", issuePrefix: "MRS" }).returning();
    const [other] = await db.insert(companies).values({ name: "Other source", issuePrefix: "MRO" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id, other!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Scoped rollback destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const before = await db.select().from(companies);
    const rejected = await request(app)
      .post(`/api/companies/${other!.id}/migrations/${applied.body.runId}/rollback`)
      .send({ confirm: "wrong source" });
    expect([403, 404, 409]).toContain(rejected.status);
    expect(await db.select().from(companies)).toEqual(before);
  });

  it("serializes concurrent confirmed applies of the same migration", async () => {
    const [source] = await db.insert(companies).values({ name: "Concurrent fixture", issuePrefix: "MCC" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const payload = {
      target: { mode: "new_company", newCompanyName: "Concurrent destination" },
      dryRun: false,
      apply: true,
      confirm: "approved pilot",
    };
    const endpoint = `/api/companies/${source!.id}/migrations`;
    const responses = await Promise.all([
      request(app).post(endpoint).send(payload),
      request(app).post(endpoint).send(payload),
    ]);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => response.status === 200 || response.status === 409)).toBe(true);
    expect((await db.select().from(companies)).filter((company) => company.name === "Concurrent destination")).toHaveLength(1);

    const retry = await request(app).post(endpoint).send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body.resume).toBe("already_completed");
    expect((await db.select().from(companies)).filter((company) => company.name === "Concurrent destination")).toHaveLength(1);
  });

  it("applies a confirmed migration once and reuses the completed run", async () => {
    const [source] = await db.insert(companies).values({ name: "Apply fixture", issuePrefix: "MAP" }).returning();
    const [sourceAgent] = await db.insert(agents).values({ companyId: source!.id, name: "Apply worker" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const payload = {
      target: { mode: "new_company", newCompanyName: "Apply destination" },
      dryRun: false,
      apply: true,
      confirm: "approved pilot",
    };
    const first = await request(app).post(`/api/companies/${source!.id}/migrations`).send(payload);
    expect(first.status).toBe(200);
    expect(first.body.dryRun).toBe(false);
    const afterFirst = await db.select().from(companies);
    const destination = afterFirst.find((company) => company.name === "Apply destination");
    expect(destination).toBeDefined();
    const agentsAfterFirst = await db.select().from(agents);
    const copiedAgents = agentsAfterFirst.filter((agent) => agent.companyId === destination!.id);
    expect(copiedAgents).toHaveLength(1);
    expect(copiedAgents[0]!.name).toBe(sourceAgent!.name);
    expect(copiedAgents[0]!.id).not.toBe(sourceAgent!.id);

    const agentApp = express();
    agentApp.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: copiedAgents[0]!.id, companyId: destination!.id, source: "agent_key" };
      next();
    });
    agentApp.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    agentApp.use(errorHandler);
    expect((await request(agentApp).get(`/api/companies/${destination!.id}`)).status).toBe(200);
    expect((await request(agentApp).get(`/api/companies/${source!.id}`)).status).toBe(403);

    const second = await request(app).post(`/api/companies/${source!.id}/migrations`).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.resume).toBe("already_completed");
    expect(await db.select().from(companies)).toEqual(afterFirst);
    expect(await db.select().from(agents)).toEqual(agentsAfterFirst);
  });
});
