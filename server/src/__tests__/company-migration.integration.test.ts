import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, assets, companies, companyLogos, companyMemberships, companyTransferRuns, createDb, issueComments, issues, principalPermissionGrants, projects } from "@myrmidon/db";

import { companyRoutes } from "../routes/companies.js";
import { companyService } from "../services/companies.js";
import { companyTransferRunService } from "../services/company-transfer-runs.js";
import { errorHandler } from "../middleware/index.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
    const sentinelPath = path.join(root, "migration-dry-run-sentinel");
    await writeFile(sentinelPath, "unchanged storage content");
    const insert = vi.spyOn(db, "insert");
    const update = vi.spyOn(db, "update");
    const remove = vi.spyOn(db, "delete");
    const putFile = vi.spyOn(storage, "putFile");
    const deleteObject = vi.spyOn(storage, "deleteObject");
    try {
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
      expect(putFile).not.toHaveBeenCalled();
      expect(deleteObject).not.toHaveBeenCalled();
      expect(await db.select().from(companies)).toEqual(beforeCompanies);
      expect(await db.select().from(agents)).toEqual(beforeAgents);
      expect(await db.select().from(projects)).toEqual(beforeProjects);
      expect(await db.select().from(issues)).toEqual(beforeIssues);
      expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
      expect(await db.select().from(activityLog)).toEqual(beforeAudit);
      expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
      expect(await readFile(sentinelPath, "utf8")).toBe("unchanged storage content");
    } finally {
      insert.mockRestore(); update.mockRestore(); remove.mockRestore();
      putFile.mockRestore(); deleteObject.mockRestore();
    }
  });

  it("rejects a source agent with a custom caste before import preview", async () => {
    const [source] = await db.insert(companies).values({ name: "Custom caste source", issuePrefix: "MCR" }).returning();
    await db.insert(agents).values({ companyId: source!.id, name: "Worker", role: "private-custom-caste" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);
    const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Destination" },
    });
    expect(response.status).toBe(200);
    expect(response.body.validation.errors).toContain("An agent has a role that cannot be migrated safely.");
    expect(response.body.validation.importPreviewSkipped).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("private-custom-caste");
  });

  it("rejects unknown source agent permissions without leaking permission metadata", async () => {
    const [source] = await db.insert(companies).values({ name: "Unknown ACL source", issuePrefix: "MUA" }).returning();
    const [worker] = await db.insert(agents).values({ companyId: source!.id, name: "Worker" }).returning();
    await db.insert(principalPermissionGrants).values({
      companyId: source!.id, principalType: "agent", principalId: worker!.id,
      permissionKey: "private-unknown-permission", scope: { secret: "private-scope-value" },
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
      target: { mode: "new_company", newCompanyName: "ACL destination" },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("unsupported agent permission");
    expect(JSON.stringify(response.body)).not.toContain("private-unknown-permission");
    expect(JSON.stringify(response.body)).not.toContain("private-scope-value");
  });

  it("rejects malformed source permission scopes without exposing their contents", async () => {
    const [source] = await db.insert(companies).values({ name: "Malformed ACL source", issuePrefix: "MMS" }).returning();
    const [worker] = await db.insert(agents).values({ companyId: source!.id, name: "Worker" }).returning();
    await db.insert(principalPermissionGrants).values({
      companyId: source!.id, principalType: "agent", principalId: worker!.id,
      permissionKey: "tasks:assign", scope: sql`'["private-scope-canary"]'::jsonb`,
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
      target: { mode: "new_company", newCompanyName: "ACL destination" },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).not.toContain("private-scope-canary");
  });

  it("reports source task comments through the real preview without leaking their contents", async () => {
    const [source] = await db.insert(companies).values({ name: "Conversation source", issuePrefix: "MCV" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: source!.id, title: "Conversation task" }).returning();
    await db.insert(issueComments).values({ companyId: source!.id, issueId: issue!.id, body: "private conversation canary" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);
    const beforeRuns = await db.select().from(companyTransferRuns);
    const beforeAudit = await db.select().from(activityLog);
    const filesBefore = await readdir(root, { recursive: true });

    const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Conversation destination" },
      export: { include: { issues: true } },
    });

    expect(response.status).toBe(200);
    expect(response.body.validation.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("comments that cannot be migrated"),
    ]));
    expect(response.body.validation.importPreviewSkipped).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("private conversation canary");
    expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
    expect(await db.select().from(activityLog)).toEqual(beforeAudit);
    expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
  });

  it("keeps concurrent repeated dry runs read-only", async () => {
    const [source] = await db.insert(companies).values({ name: "Concurrent dry run source", issuePrefix: "MDR" }).returning();
    await db.insert(agents).values({ companyId: source!.id, name: "Dry run worker" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const beforeCompanies = await db.select().from(companies);
    const beforeAgents = await db.select().from(agents);
    const beforeRuns = await db.select().from(companyTransferRuns);
    const beforeAudit = await db.select().from(activityLog);
    const filesBefore = await readdir(root, { recursive: true });
    const endpoint = `/api/companies/${source!.id}/migrations`;
    const payload = { target: { mode: "new_company", newCompanyName: "Concurrent dry run destination" } };
    const responses = await Promise.all([
      request(app).post(endpoint).send(payload),
      request(app).post(endpoint).send(payload),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses[0]!.body).toEqual(responses[1]!.body);
    expect(responses[0]!.body.dryRun).toBe(true);
    expect(responses[0]!.body.runKey).toMatch(/^[a-f0-9]{64}$/);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(agents)).toEqual(beforeAgents);
    expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
    expect(await db.select().from(activityLog)).toEqual(beforeAudit);
    expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
  });

  it("changes the dry-run identity when source content changes", async () => {
    const [source] = await db.insert(companies).values({ name: "Identity source", issuePrefix: "MID" }).returning();
    const [worker] = await db.insert(agents).values({ companyId: source!.id, name: "Original worker" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);
    const endpoint = `/api/companies/${source!.id}/migrations`;
    const payload = { target: { mode: "new_company", newCompanyName: "Identity destination" } };
    const first = await request(app).post(endpoint).send(payload);
    expect(first.status).toBe(200);
    expect(first.body.runKey).toMatch(/^[a-f0-9]{64}$/);
    const { eq } = await import("drizzle-orm");
    await db.update(agents).set({ name: "Changed worker" }).where(eq(agents.id, worker!.id));
    const second = await request(app).post(endpoint).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.runKey).not.toBe(first.body.runKey);
    const third = await request(app).post(endpoint).send(payload);
    expect(third.status).toBe(200);
    expect(third.body.runKey).toBe(second.body.runKey);
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

  it("accepts explicit apply=false as a read-only dry run", async () => {
    const [source] = await db.insert(companies).values({ name: "Explicit dry-run source", issuePrefix: "MED" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
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
        target: { mode: "new_company", newCompanyName: "Explicit dry-run destination" },
        apply: false,
      });
      expect(response.status).toBe(200);
      expect(response.body.dryRun).toBe(true);
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

  it("never writes when dry-run is explicitly combined with a confirmed apply", async () => {
    const [source] = await db.insert(companies).values({ name: "Dry-run conflict source", issuePrefix: "MDC" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
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
        target: { mode: "new_company", newCompanyName: "Dry-run conflict destination" },
        dryRun: true, apply: true, confirm: "approved pilot",
      });
      expect(response.status === 400 || (response.status === 200 && response.body.dryRun === true)).toBe(true);
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

  it("applies a confirmed migration once when the same request is retried", async () => {
    const [source] = await db.insert(companies).values({ name: "Apply retry source", issuePrefix: "MRA" }).returning();
    await db.insert(agents).values({ companyId: source!.id, name: "Apply retry worker" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);
    const payload = {
      target: { mode: "new_company", newCompanyName: "Apply retry destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    };
    const endpoint = `/api/companies/${source!.id}/migrations`;
    const first = await request(app).post(endpoint).send(payload);
    expect(first.status).toBe(200);
    expect(first.body.dryRun).toBe(false);
    const companiesAfterFirst = await db.select().from(companies);
    const agentsAfterFirst = await db.select().from(agents);
    const second = await request(app).post(endpoint).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.resume).toBe("already_completed");
    expect(second.body.runId).toBe(first.body.runId);
    expect(await db.select().from(companies)).toEqual(companiesAfterFirst);
    expect(await db.select().from(agents)).toEqual(agentsAfterFirst);
  });

  it("rolls back the destination owned by a completed migration without touching the source", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback source", issuePrefix: "MRB" }).returning();
    const [worker] = await db.insert(agents).values({ companyId: source!.id, name: "Rollback worker" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);
    const endpoint = `/api/companies/${source!.id}/migrations`;
    const applied = await request(app).post(endpoint).send({
      target: { mode: "new_company", newCompanyName: "Rollback destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const run = await companyTransferRunService.getRun(db, applied.body.runId);
    expect(run?.companyId).toBeTruthy();
    expect(run?.companyId).not.toBe(source!.id);
    const destinationId = run!.companyId;
    expect((await db.select().from(agents)).some((agent) => agent.companyId === destinationId)).toBe(true);

    const rollback = await request(app).post(`${endpoint}/${run!.id}/rollback`).send({ confirm: "rollback pilot" });
    expect(rollback.status).toBe(200);
    expect((await db.select().from(agents)).some((agent) => agent.companyId === destinationId)).toBe(false);
    expect((await db.select().from(agents)).some((agent) => agent.id === worker!.id && agent.companyId === source!.id)).toBe(true);
    expect((await db.select().from(companies)).some((company) => company.id === source!.id)).toBe(true);
  });

  it("allows only one concurrent rollback of a completed migration", async () => {
    const [source] = await db.insert(companies).values({ name: "Concurrent rollback source", issuePrefix: "MCRB" }).returning();
    await db.insert(agents).values({ companyId: source!.id, name: "Concurrent rollback worker" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);
    const endpoint = `/api/companies/${source!.id}/migrations`;
    const applied = await request(app).post(endpoint).send({
      target: { mode: "new_company", newCompanyName: "Concurrent rollback destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const run = await companyTransferRunService.getRun(db, applied.body.runId);
    expect(run?.companyId).toBeTruthy();
    const responses = await Promise.all([
      request(app).post(`${endpoint}/${run!.id}/rollback`).send({ confirm: "rollback pilot" }),
      request(app).post(`${endpoint}/${run!.id}/rollback`).send({ confirm: "rollback pilot" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await db.select().from(agents)).some((agent) => agent.companyId === run!.companyId)).toBe(false);
    expect((await db.select().from(companies)).some((company) => company.id === source!.id)).toBe(true);
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

  it("scopes migration status to its source and excludes ledger details", async () => {
    const [source] = await db.insert(companies).values({ name: "Status source", issuePrefix: "MST" }).returning();
    const [other] = await db.insert(companies).values({ name: "Status other", issuePrefix: "MSO" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "failed", actorKey: "migration-test",
      idempotencyKey: "private-status-key", error: "private-status-error",
      containerRef: { kind: "company_migration", sourceCompanyId: source!.id },
    }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id, other!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const visible = await request(app).get(`/api/companies/${source!.id}/migrations/${run!.id}`);
    expect(visible.status).toBe(200);
    expect(visible.body).toEqual({ runId: run!.id, status: "failed" });
    expect(JSON.stringify(visible.body)).not.toContain("private-status");
    const crossCompany = await request(app).get(`/api/companies/${other!.id}/migrations/${run!.id}`);
    expect(crossCompany.status).toBe(404);
    const invalid = await request(app).get(`/api/companies/${source!.id}/migrations/not-a-run-id`);
    expect(invalid.status).toBe(404);
  });

  it("rejects rollback of a claimed migration without changing its destination or ledger", async () => {
    const [source] = await db.insert(companies).values({ name: "Recovery safety source", issuePrefix: "MSS" }).returning();
    const [destination] = await db.insert(companies).values({ name: "Recovery safety destination", issuePrefix: "MSD" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "failed", actorKey: "migration-test",
      idempotencyKey: "migration-recovery-unavailable", companyId: destination!.id,
      containerRef: { kind: "company_migration", sourceCompanyId: source!.id },
    }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);
    const beforeCompanies = await db.select().from(companies);
    const beforeRuns = await db.select().from(companyTransferRuns);
    const beforeAudit = await db.select().from(activityLog);
    const filesBefore = await readdir(root, { recursive: true });

    const response = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${run!.id}/rollback`)
      .send({ confirm: "recover interrupted pilot" });

    expect(response.status).toBe(404);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
    expect(await db.select().from(activityLog)).toEqual(beforeAudit);
    expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
  });

  it("refuses rollback while the migration apply owns the destination", async () => {
    const [source] = await db.insert(companies).values({ name: "Active rollback source", issuePrefix: "MRS" }).returning();
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, source!.id, "active-rollback-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Active rollback destination" }, { transferRunId: run.id });
    const [worker] = await db.insert(agents).values({ companyId: destination.id, name: "Active migration worker" }).returning();
    const beforeRun = await companyTransferRunService.getRun(db, run.id);
    const beforeCompanies = await db.select().from(companies);
    const beforeAgents = await db.select().from(agents);
    const beforeAudit = await db.select().from(activityLog);
    const filesBefore = await readdir(root, { recursive: true });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const response = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${run.id}/rollback`)
      .send({ confirm: "rollback pilot" });

    expect(response.status).toBe(409);
    expect(await companyTransferRunService.getRun(db, run.id)).toEqual(beforeRun);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(agents)).toEqual(beforeAgents);
    expect((await db.select().from(agents)).some((agent) => agent.id === worker!.id)).toBe(true);
    expect(await db.select().from(activityLog)).toEqual(beforeAudit);
    expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
  });

  it("serializes migration ledger declarations across operators and isolates sources", async () => {
    const key = "migration-ledger-concurrent-fixture";
    const [first, second] = await Promise.all([
      companyTransferRunService.resumeOrCreateMigration(db, "source-one", key),
      companyTransferRunService.resumeOrCreateMigration(db, "source-one", key),
    ]);
    expect(first.run.id).toBe(second.run.id);
    expect([first.resumed, second.resumed].sort()).toEqual([false, true]);
    const otherSource = await companyTransferRunService.resumeOrCreateMigration(db, "source-two", key);
    expect(otherSource.run.id).not.toBe(first.run.id);
    expect(otherSource.run.containerRef).toMatchObject({ kind: "company_migration", sourceCompanyId: "source-two" });
    expect(await companyTransferRunService.claimApply(db, first.run.id)).toBe(true);
    await companyService(db).create({ name: "Ledger completion destination" }, { transferRunId: first.run.id });
    expect(await companyTransferRunService.complete(db, first.run.id)).toBe(true);
    const retry = await companyTransferRunService.resumeOrCreateMigration(db, "source-one", key);
    expect(retry.alreadyCompleted).toBe(true);
    expect(retry.run.id).toBe(first.run.id);
  });

  it("cannot mark an unclaimed migration as completed", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "unclaimed-source", "unclaimed-completion");
    await companyTransferRunService.complete(db, run.id);
    const retry = await companyTransferRunService.resumeOrCreateMigration(db, "unclaimed-source", "unclaimed-completion");
    expect(retry.alreadyCompleted).toBe(false);
    expect(retry.run.status).toBe("pending");
  });

  it("does not complete a migration when its destination provenance disagrees", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "completion-mismatch-source", "completion-mismatch-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Completion mismatch destination" }, { transferRunId: run.id });
    await db.update(companyTransferRuns).set({
      containerRef: { kind: "company_migration", sourceCompanyId: "completion-mismatch-source", destinationClaimed: true, destinationCompanyId: "different-destination" },
    }).where(eq(companyTransferRuns.id, run.id));

    expect(await companyTransferRunService.complete(db, run.id)).toBe(false);
    const saved = await companyTransferRunService.getRun(db, run.id);
    expect(saved?.status).toBe("applying");
    expect(saved?.companyId).toBe(destination.id);
    expect((await companyTransferRunService.resumeOrCreateMigration(db, "completion-mismatch-source", "completion-mismatch-key")).alreadyCompleted).toBe(false);
  });

  it("does not complete a migration whose provenance identifies the source as destination", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "completion-source", "completion-source-corruption");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Corrupt completion destination" }, { transferRunId: run.id });
    await db.update(companyTransferRuns).set({
      containerRef: { kind: "company_migration", sourceCompanyId: destination.id, destinationClaimed: true, destinationCompanyId: destination.id },
    }).where(eq(companyTransferRuns.id, run.id));

    await companyTransferRunService.complete(db, run.id);
    expect((await companyTransferRunService.getRun(db, run.id))?.status).toBe("applying");
  });

  it("does not reopen a completed migration when a late failure is recorded", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "late-failure-source", "late-failure-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    await companyService(db).create({ name: "Late failure destination" }, { transferRunId: run.id });
    await companyTransferRunService.complete(db, run.id);

    await companyTransferRunService.fail(db, run.id, "late cleanup failure");
    const retry = await companyTransferRunService.resumeOrCreateMigration(db, "late-failure-source", "late-failure-key");
    expect(retry.run.id).toBe(run.id);
    expect(retry.run.status).toBe("completed");
    expect(retry.alreadyCompleted).toBe(true);
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(false);
  });

  it("does not let an unguarded failure release an active migration apply", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "active-source", "active-apply-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    await companyTransferRunService.fail(db, run.id, "unrelated failure");
    expect((await companyTransferRunService.getRun(db, run.id))?.status).toBe("applying");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(false);
    expect(await companyTransferRunService.releaseApplyClaim(db, run.id, "apply failed")).toBe(true);
    expect((await companyTransferRunService.getRun(db, run.id))?.status).toBe("failed");
  });

  it("does not persist secret-bearing manifests in the migration ledger", async () => {
    const declared = await companyTransferRunService.resumeOrCreateMigration(db, "manifest-source", "manifest-redaction");
    const before = await companyTransferRunService.getRun(db, declared.run.id);
    await companyTransferRunService.recordManifest(db, declared.run.id, {
      secretValue: "private-migration-value", chunks: [], blobs: [],
    }, "manifest-hash");
    const after = await companyTransferRunService.getRun(db, declared.run.id);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("private-migration-value");
  });

  it("does not persist arbitrary part names in the migration ledger", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "part-source", "part-redaction");
    const before = await companyTransferRunService.getRun(db, run.id);
    expect(await companyTransferRunService.completePart(db, run.id, "private-part-value")).toBe(false);
    const after = await companyTransferRunService.getRun(db, run.id);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("private-part-value");
  });

  it("does not persist upstream error details when a migration apply fails", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "redaction-source", "redaction-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    expect(await companyTransferRunService.releaseApplyClaim(db, run.id, "secret-value-canary")).toBe(true);
    const saved = await companyTransferRunService.getRun(db, run.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.error).toBeTruthy();
    expect(JSON.stringify(saved)).not.toContain("secret-value-canary");

    const pending = await companyTransferRunService.resumeOrCreateMigration(db, "redaction-source", "pending-redaction-key");
    await companyTransferRunService.fail(db, pending.run.id, "other-secret-canary");
    const failedPending = await companyTransferRunService.getRun(db, pending.run.id);
    expect(failedPending?.status).toBe("failed");
    expect(failedPending?.error).toBeTruthy();
    expect(JSON.stringify(failedPending)).not.toContain("other-secret-canary");
  });

  it("does not persist idle sweep error details for migration runs", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "idle-redaction-source", "idle-redaction-key");
    const cancelled = await companyTransferRunService.cancelIfIdle(db, run.id, new Date(Date.now() + 60_000), "idle-secret-canary");
    expect(cancelled).toBe(true);
    const saved = await companyTransferRunService.getRun(db, run.id);
    expect(saved?.status).toBe("cancelled");
    expect(saved?.error).toBeTruthy();
    expect(JSON.stringify(saved)).not.toContain("idle-secret-canary");
  });

  it("serializes rollback claims and preserves the run across restart recovery", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "rollback-claim-source", "rollback-claim-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Rollback claim destination" }, { transferRunId: run.id });
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");

    const claims = await Promise.all([
      companyTransferRunService.claimMigrationRollback(db, run.id, "rollback-claim-source"),
      companyTransferRunService.claimMigrationRollback(db, run.id, "rollback-claim-source"),
    ]);
    expect(claims.sort()).toEqual([false, true]);
    const during = await companyTransferRunService.resumeOrCreateMigration(db, "rollback-claim-source", "rollback-claim-key");
    expect(during.run.id).toBe(run.id);
    expect(during.run.status).toBe("rolling_back");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(false);

    expect(await companyTransferRunService.recoverStrandedApplyingRuns(db)).toContain(run.id);
    const recovered = await companyTransferRunService.getRun(db, run.id);
    expect(recovered?.status).toBe("failed");
    expect(recovered?.companyId).toBe(destination.id);
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "other-source")).toBe(false);
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "rollback-claim-source")).toBe(true);
  });

  it("refuses to claim rollback when provenance identifies the source as the destination", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback source guard", issuePrefix: "RSG" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "failed", actorKey: `company_migration:${source!.id}`,
      idempotencyKey: "rollback-source-guard", companyId: source!.id,
      containerRef: { kind: "company_migration", sourceCompanyId: source!.id, destinationClaimed: true, destinationCompanyId: source!.id },
    }).returning();

    expect(await companyTransferRunService.claimMigrationRollback(db, run!.id, source!.id)).toBe(false);
    expect((await companyTransferRunService.getRun(db, run!.id))?.status).toBe("failed");
    expect((await db.select().from(companies)).some((company) => company.id === source!.id)).toBe(true);
  });

  it("refuses rollback claims when destination provenance disagrees with the company foreign key", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "rollback-mismatch-source", "rollback-mismatch-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Rollback mismatch destination" }, { transferRunId: run.id });
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    await db.update(companyTransferRuns).set({
      containerRef: { kind: "company_migration", sourceCompanyId: "rollback-mismatch-source", destinationClaimed: true, destinationCompanyId: "different-destination" },
    }).where(eq(companyTransferRuns.id, run.id));

    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "rollback-mismatch-source")).toBe(false);
    const saved = await companyTransferRunService.getRun(db, run.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.companyId).toBe(destination.id);
  });

  it("refuses a rollback claim if its live destination lost the ledger foreign key", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "lost-fk-source", "lost-fk-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Lost foreign key destination" }, { transferRunId: run.id });
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    await db.update(companyTransferRuns).set({ companyId: null }).where(eq(companyTransferRuns.id, run.id));

    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "lost-fk-source")).toBe(false);
    expect((await companyTransferRunService.getRun(db, run.id))?.status).toBe("failed");
    expect((await db.select().from(companies)).some((company) => company.id === destination.id)).toBe(true);
  });

  it("releases a failed rollback claim without losing provenance or exposing errors", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "rollback-error-source", "rollback-error-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Rollback error destination" }, { transferRunId: run.id });
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "rollback-error-source")).toBe(true);
    expect(await companyTransferRunService.releaseMigrationRollbackClaim(db, run.id, "secret-error-canary")).toBe(true);
    const saved = await companyTransferRunService.getRun(db, run.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.companyId).toBe(destination.id);
    expect(JSON.stringify(saved)).not.toContain("secret-error-canary");
    expect(await companyTransferRunService.releaseMigrationRollbackClaim(db, run.id, "stale")).toBe(false);
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "rollback-error-source")).toBe(true);
  });

  it("does not settle rollback while its destination still exists and is active", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "live-rollback-source", "live-rollback-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Live rollback destination" }, { transferRunId: run.id });
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "live-rollback-source")).toBe(true);

    expect(await companyTransferRunService.finishMigrationRollback(db, run.id)).toBe(false);
    const saved = await companyTransferRunService.getRun(db, run.id);
    expect(saved?.status).toBe("rolling_back");
    expect(saved?.companyId).toBe(destination.id);
  });

  it("does not settle rollback when destination ownership remains but its foreign key was cleared", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "orphan-rollback-source", "orphan-rollback-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Orphan rollback destination" }, { transferRunId: run.id });
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "orphan-rollback-source")).toBe(true);
    await db.update(companyTransferRuns).set({ companyId: null }).where(eq(companyTransferRuns.id, run.id));

    expect(await companyTransferRunService.finishMigrationRollback(db, run.id)).toBe(false);
    expect((await companyTransferRunService.getRun(db, run.id))?.status).toBe("rolling_back");
    expect((await db.select().from(companies)).some((company) => company.id === destination.id)).toBe(true);
  });

  it("refuses to settle rollback if destination provenance changes to the source after the claim", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "settlement-source", "settlement-source-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Settlement destination" }, { transferRunId: run.id });
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "settlement-source")).toBe(true);
    await db.delete(companies).where(eq(companies.id, destination.id));
    await db.update(companyTransferRuns).set({
      containerRef: { kind: "company_migration", sourceCompanyId: "settlement-source", destinationClaimed: true, destinationCompanyId: "settlement-source" },
    }).where(eq(companyTransferRuns.id, run.id));

    expect(await companyTransferRunService.finishMigrationRollback(db, run.id)).toBe(false);
    expect((await companyTransferRunService.getRun(db, run.id))?.status).toBe("rolling_back");
  });

  it("settles rollback once and retains the migration identity after cleanup", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "rollback-complete-source", "rollback-complete-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Rollback complete destination" }, { transferRunId: run.id });
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    expect(await companyTransferRunService.finishMigrationRollback(db, run.id)).toBe(false);
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "rollback-complete-source")).toBe(true);
    await db.delete(companies).where(eq(companies.id, destination.id));
    await db.update(companyTransferRuns).set({ completedParts: ["reserved-object"] }).where(eq(companyTransferRuns.id, run.id));
    expect(await companyTransferRunService.finishMigrationRollback(db, run.id)).toBe(false);
    await db.update(companyTransferRuns).set({ completedParts: [] }).where(eq(companyTransferRuns.id, run.id));
    expect(await companyTransferRunService.finishMigrationRollback(db, run.id)).toBe(true);
    expect(await companyTransferRunService.finishMigrationRollback(db, run.id)).toBe(false);
    await companyTransferRunService.fail(db, run.id, "late error");
    const retry = await companyTransferRunService.resumeOrCreateMigration(db, "rollback-complete-source", "rollback-complete-key");
    expect(retry.run.id).toBe(run.id);
    expect(retry.run.status).toBe("rolled_back");
    expect(retry.run.companyId).toBeNull();
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(false);
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "rollback-complete-source")).toBe(false);
  });

  it("acknowledges only reserved objects during the owning rollback", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "cleanup-source", "cleanup-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Cleanup destination" }, { transferRunId: run.id });
    const storage = createStorageService(createLocalDiskStorageProvider(root));
    let key = "";
    await storage.putFile({
      companyId: destination.id, namespace: "assets/general", originalFilename: "fixture.png",
      contentType: "image/png", body: Buffer.from("fixture"),
      beforeWrite: async (objectKey) => {
        key = objectKey;
        await companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, objectKey);
      },
    });
    expect(await companyTransferRunService.acknowledgeMigrationObjectDeletion(db, run.id, destination.id, key)).toBe(false);
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, "cleanup-source")).toBe(true);
    expect(await companyTransferRunService.acknowledgeMigrationObjectDeletion(db, run.id, "other-company", key)).toBe(false);
    expect(await companyTransferRunService.acknowledgeMigrationObjectDeletion(db, run.id, destination.id, "unknown")).toBe(false);
    await storage.deleteObject(destination.id, key);
    expect(await companyTransferRunService.acknowledgeMigrationObjectDeletion(db, run.id, destination.id, key)).toBe(true);
    expect(await companyTransferRunService.acknowledgeMigrationObjectDeletion(db, run.id, destination.id, key)).toBe(false);
    expect((await companyTransferRunService.getRun(db, run.id))?.completedParts).toEqual([]);
  });

  it("preserves destination and storage provenance when startup recovers an interrupted apply", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "crash-source", "crash-reservation");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Crash recovery destination" }, { transferRunId: run.id });
    const storage = createStorageService(createLocalDiskStorageProvider(root));
    let key = "";
    await storage.putFile({
      companyId: destination.id, namespace: "assets/general", originalFilename: "logo.png",
      contentType: "image/png", body: Buffer.from("recovery fixture"),
      beforeWrite: async (objectKey) => {
        key = objectKey;
        await companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, objectKey);
      },
    });

    expect(await companyTransferRunService.recoverStrandedApplyingRuns(db)).toContain(run.id);
    const recovered = await companyTransferRunService.getRun(db, run.id);
    expect(recovered?.status).toBe("failed");
    expect(recovered?.companyId).toBe(destination.id);
    expect(recovered?.completedParts).toEqual([key]);
    expect((await storage.headObject(destination.id, key)).exists).toBe(true);
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(false);
    const retry = await companyTransferRunService.resumeOrCreateMigration(db, "crash-source", "crash-reservation");
    expect(retry.run.id).toBe(run.id);
    expect(retry.alreadyCompleted).toBe(false);
  });

  it("retains the run identity after its migration-owned destination is deleted", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "deleted-destination-source", "deleted-destination-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Deleted destination" }, { transferRunId: run.id });
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    await db.delete(companies).where(eq(companies.id, destination!.id));

    const afterDeletion = await companyTransferRunService.getRun(db, run.id);
    expect(afterDeletion?.companyId).toBeNull();
    expect(afterDeletion?.containerRef).toMatchObject({ destinationClaimed: true, destinationCompanyId: destination.id });
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(false);
    await companyTransferRunService.cancel(db, run.id);
    const retry = await companyTransferRunService.resumeOrCreateMigration(db, "deleted-destination-source", "deleted-destination-key");
    expect(retry.run.id).toBe(run.id);
    expect(retry.run.status).toBe("failed");
  });

  it("does not claim a second destination after the first is deleted while applying", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "deleted-active-source", "deleted-active-key");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "First active destination" }, { transferRunId: run.id });
    await db.delete(companies).where(eq(companies.id, destination.id));

    await expect(companyService(db).create({ name: "Second active destination" }, { transferRunId: run.id }))
      .rejects.toThrow("Transfer run cannot claim a new company");
    expect((await db.select().from(companies)).some((company) => company.name === "Second active destination")).toBe(false);
    expect((await companyTransferRunService.getRun(db, run.id))?.companyId).toBeNull();
  });

  it("does not reapply a failed migration after it has claimed a destination", async () => {
    const [source] = await db.insert(companies).values({ name: "Retry safety source", issuePrefix: "MRY" }).returning();
    const [destination] = await db.insert(companies).values({ name: "Retry safety destination", issuePrefix: "MRD" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "failed", actorKey: "migration-test",
      idempotencyKey: "migration-failed-destination", companyId: destination!.id,
      containerRef: { kind: "company_migration", sourceCompanyId: source!.id },
    }).returning();
    expect(await companyTransferRunService.claimApply(db, run!.id)).toBe(false);
    expect((await companyTransferRunService.getRun(db, run!.id))?.status).toBe("failed");
  });

  it("preserves a failed migration with an owned destination when cancellation is requested", async () => {
    const [destination] = await db.insert(companies).values({ name: "Cancel safety destination", issuePrefix: "MCS" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "failed", actorKey: "company_migration:cancel-source",
      idempotencyKey: "migration-cancel-safety", companyId: destination!.id,
      containerRef: { kind: "company_migration", sourceCompanyId: "cancel-source" },
    }).returning();

    await companyTransferRunService.cancel(db, run!.id);
    const retry = await companyTransferRunService.resumeOrCreateMigration(db, "cancel-source", "migration-cancel-safety");
    expect(retry.run.id).toBe(run!.id);
    expect(retry.run.status).toBe("failed");
    expect(await companyTransferRunService.claimApply(db, retry.run.id)).toBe(false);
  });

  it("retains an owned migration when an idle sweep attempts cancellation", async () => {
    const [destination] = await db.insert(companies).values({ name: "Idle safety destination", issuePrefix: "MIS" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "running", actorKey: "company_migration:idle-source",
      idempotencyKey: "migration-idle-safety", companyId: destination!.id,
      containerRef: { kind: "company_migration", sourceCompanyId: "idle-source" },
      updatedAt: new Date(0),
    }).returning();

    expect(await companyTransferRunService.cancelIfIdle(db, run!.id, new Date(), "idle")).toBe(false);
    const retry = await companyTransferRunService.resumeOrCreateMigration(db, "idle-source", "migration-idle-safety");
    expect(retry.run.id).toBe(run!.id);
    expect(retry.run.companyId).toBe(destination!.id);
    expect(await companyTransferRunService.claimApply(db, run!.id)).toBe(false);
  });

  it("does not restart a failed migration with an owned destination", async () => {
    const [destination] = await db.insert(companies).values({ name: "Restart safety destination", issuePrefix: "MRT" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "failed", actorKey: "company_migration:restart-source",
      idempotencyKey: "migration-restart-safety", companyId: destination!.id,
      containerRef: { kind: "company_migration", sourceCompanyId: "restart-source" },
      error: "interrupted apply",
    }).returning();

    await companyTransferRunService.start(db, run!.id);
    const saved = await companyTransferRunService.getRun(db, run!.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.error).toBe("interrupted apply");
    expect(saved?.companyId).toBe(destination!.id);
  });

  it("does not block a regular import retry merely because it has a destination", async () => {
    const [destination] = await db.insert(companies).values({ name: "Regular retry destination", issuePrefix: "MRG" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "failed", actorKey: "migration-test",
      idempotencyKey: "regular-import-failed-destination", companyId: destination!.id,
      containerRef: { kind: "company_import" },
    }).returning();
    expect(await companyTransferRunService.claimApply(db, run!.id)).toBe(true);
    expect((await companyTransferRunService.getRun(db, run!.id))?.status).toBe("applying");
  });

  it("rejects storage reservations on export runs even if their metadata resembles a migration", async () => {
    const [destination] = await db.insert(companies).values({ name: "Export reservation destination", issuePrefix: "MER" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "export", status: "applying", actorKey: "migration-test",
      idempotencyKey: "export-reservation-rejected", companyId: destination!.id,
      containerRef: { kind: "company_migration", sourceCompanyId: "source" },
    }).returning();
    const key = `${destination!.id}/assets/general/2026/11/16/12345678-1234-4123-8123-123456789abc-file`;
    await expect(companyTransferRunService.reserveMigrationObject(db, run!.id, destination!.id, key)).rejects.toThrow();
    expect((await companyTransferRunService.getRun(db, run!.id))?.completedParts).toEqual([]);
  });

  it("does not write storage when migration reservation fails", async () => {
    const [destination] = await db.insert(companies).values({ name: "Reservation failure destination", issuePrefix: "MRF" }).returning();
    const storage = createStorageService(createLocalDiskStorageProvider(root));
    let attemptedKey = "";
    await expect(storage.putFile({
      companyId: destination!.id,
      namespace: "migration",
      originalFilename: "private-name.txt",
      contentType: "text/plain",
      body: Buffer.from("private content"),
      beforeWrite: async (objectKey) => {
        attemptedKey = objectKey;
        throw new Error("reservation failed");
      },
    })).rejects.toThrow("reservation failed");
    expect(attemptedKey).not.toBe("");
    expect(attemptedKey).not.toContain("private-name");
    expect((await storage.headObject(destination!.id, attemptedKey)).exists).toBe(false);
  });

  it("reserves storage keys only for the applying migration's owned destination", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "storage-source", "storage-reservation");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Storage reservation destination" }, { transferRunId: run.id });
    const storage = createStorageService(createLocalDiskStorageProvider(root));
    const input = { companyId: destination.id, namespace: "assets/general", originalFilename: "asset.txt", contentType: "text/plain", body: Buffer.from("asset") };
    let key = "";
    await storage.putFile({ ...input, beforeWrite: async (objectKey) => {
      key = objectKey;
      await companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, objectKey);
      await companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, objectKey);
    } });
    expect((await companyTransferRunService.getRun(db, run.id))?.completedParts).toEqual([key]);
    await expect(companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, `other/${key}`)).rejects.toThrow();
    await expect(companyTransferRunService.reserveMigrationObject(db, run.id, "other", key)).rejects.toThrow();
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    await expect(companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, key)).rejects.toThrow();
    expect((await companyTransferRunService.getRun(db, run.id))?.completedParts).toEqual([key]);
  });

  it("does not acknowledge object deletion if rollback provenance changes to the source", async () => {
    const [source] = await db.insert(companies).values({ name: "Acknowledgement source", issuePrefix: "MAS" }).returning();
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, source!.id, "ack-source-provenance");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Acknowledgement destination" }, { transferRunId: run.id });
    const key = `${destination.id}/assets/general/2026/11/16/550e8400-e29b-41d4-a716-446655440000-file`;
    await companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, key);
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, source!.id)).toBe(true);
    await db.update(companyTransferRuns).set({
      containerRef: { kind: "company_migration", sourceCompanyId: destination.id, destinationClaimed: true, destinationCompanyId: destination.id },
    }).where(eq(companyTransferRuns.id, run.id));

    expect(await companyTransferRunService.acknowledgeMigrationObjectDeletion(db, run.id, destination.id, key)).toBe(false);
    expect((await companyTransferRunService.getRun(db, run.id))?.completedParts).toEqual([key]);
  });

  it("does not acknowledge object deletion when a live destination is detached from its run", async () => {
    const [source] = await db.insert(companies).values({ name: "Detached acknowledgement source", issuePrefix: "MDA" }).returning();
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, source!.id, "detached-acknowledgement");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Detached acknowledgement destination" }, { transferRunId: run.id });
    const key = `${destination.id}/assets/general/2026/11/16/550e8400-e29b-41d4-a716-446655440000-file`;
    await companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, key);
    await companyTransferRunService.releaseApplyClaim(db, run.id, "interrupted");
    expect(await companyTransferRunService.claimMigrationRollback(db, run.id, source!.id)).toBe(true);
    await db.update(companyTransferRuns).set({ companyId: null }).where(eq(companyTransferRuns.id, run.id));

    expect(await companyTransferRunService.acknowledgeMigrationObjectDeletion(db, run.id, destination.id, key)).toBe(false);
    expect((await companyTransferRunService.getRun(db, run.id))?.completedParts).toEqual([key]);
  });

  it("rejects storage reservations when durable destination provenance disagrees", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "reservation-provenance-source", "reservation-provenance");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Reservation provenance destination" }, { transferRunId: run.id });
    await db.update(companyTransferRuns).set({
      containerRef: { kind: "company_migration", sourceCompanyId: "reservation-provenance-source", destinationClaimed: true, destinationCompanyId: "different-destination" },
    }).where(eq(companyTransferRuns.id, run.id));
    const key = `${destination.id}/assets/general/2026/11/16/550e8400-e29b-41d4-a716-446655440000-file`;

    await expect(companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, key)).rejects.toThrow();
    expect((await companyTransferRunService.getRun(db, run.id))?.completedParts).toEqual([]);
  });

  it("rejects storage reservations if provenance identifies the destination as the source", async () => {
    const [source] = await db.insert(companies).values({ name: "Reservation source", issuePrefix: "MRS" }).returning();
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, source!.id, "reservation-source-corruption");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Reservation destination" }, { transferRunId: run.id });
    await db.update(companyTransferRuns).set({
      containerRef: { kind: "company_migration", sourceCompanyId: destination.id, destinationClaimed: true, destinationCompanyId: destination.id },
    }).where(eq(companyTransferRuns.id, run.id));
    const key = `${destination.id}/assets/general/2026/11/16/550e8400-e29b-41d4-a716-446655440000-file`;

    await expect(companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, key)).rejects.toThrow();
    expect((await companyTransferRunService.getRun(db, run.id))?.completedParts).toEqual([]);
  });

  it("rejects storage reservations that are not generated migration object keys", async () => {
    const { run } = await companyTransferRunService.resumeOrCreateMigration(db, "reservation-validation-source", "reservation-validation");
    expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
    const destination = await companyService(db).create({ name: "Reservation validation destination" }, { transferRunId: run.id });
    const invalidKeys = [
      `${destination.id}/assets/general/private-name.txt`,
      `${destination.id}/assets/general/2026/11/16/not-a-uuid-file`,
      `${destination.id}/assets/general/abcd/11/16/550e8400-e29b-41d4-a716-446655440000-file`,
      `${destination.id}/assets/general/2026/02/30/550e8400-e29b-41d4-a716-446655440000-file`,
      `${destination.id}/assets/general/2026/13/01/550e8400-e29b-41d4-a716-446655440000-file`,
      `${destination.id}/assets/general/2026/11/16/550e8400-e29b-41d4-a716-446655440000-private-name.txt`,
      `${destination.id}/assets/general/2026/11/16/550e8400-e29b-41d4-a716-446655440000-file/extra`,
      `${destination.id}/assets/general/2026/11/16/550e8400-e29b-41d4-a716-446655440000-file\\extra`,
      `${destination.id}/private-secret-canary/2026/11/16/550e8400-e29b-41d4-a716-446655440000-file`,
      `${destination.id}/issues/private-secret-canary/2026/11/16/550e8400-e29b-41d4-a716-446655440000-file`,
    ];
    for (const key of invalidKeys) {
      await expect(companyTransferRunService.reserveMigrationObject(db, run.id, destination.id, key)).rejects.toThrow();
    }
    expect((await companyTransferRunService.getRun(db, run.id))?.completedParts).toEqual([]);
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

  it("does not allow a migration's destination provenance to be replaced", async () => {
    const [source] = await db.insert(companies).values({ name: "Provenance source", issuePrefix: "MPT" }).returning();
    const [owned] = await db.insert(companies).values({ name: "Owned destination", issuePrefix: "MPU" }).returning();
    const [other] = await db.insert(companies).values({ name: "Independent destination", issuePrefix: "MPV" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "completed", actorKey: "migration-test",
      idempotencyKey: "immutable-migration-destination", companyId: owned!.id,
      containerRef: { kind: "company_migration", sourceCompanyId: source!.id },
    }).returning();

    await expect(companyTransferRunService.attachCompany(db, run!.id, other!.id)).rejects.toThrow();
    expect((await companyTransferRunService.getRun(db, run!.id))?.companyId).toBe(owned!.id);
    await companyTransferRunService.attachCompany(db, run!.id, owned!.id);
    expect((await companyTransferRunService.getRun(db, run!.id))?.companyId).toBe(owned!.id);
  });

  it("cannot attach an independently created company to an unclaimed migration", async () => {
    const [source] = await db.insert(companies).values({ name: "Unclaimed migration source", issuePrefix: "MUS" }).returning();
    const [independent] = await db.insert(companies).values({ name: "Independent company", issuePrefix: "MUI" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "applying", actorKey: "migration-test",
      idempotencyKey: "unclaimed-migration-destination",
      containerRef: { kind: "company_migration", sourceCompanyId: source!.id },
    }).returning();
    await expect(companyTransferRunService.attachCompany(db, run!.id, independent!.id)).rejects.toThrow();
    expect((await companyTransferRunService.getRun(db, run!.id))?.companyId).toBeNull();
  });

  it("does not let a transfer run claim a second destination", async () => {
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "applying", actorKey: "migration-test",
      idempotencyKey: "provenance-single-destination", containerRef: {},
    }).returning();
    const first = await companyService(db).create({ name: "First provenance destination" }, { transferRunId: run!.id });
    await expect(companyService(db).create({ name: "Second provenance destination" }, { transferRunId: run!.id }))
      .rejects.toThrow("Transfer run cannot claim a new company");
    const saved = (await db.select().from(companyTransferRuns)).find((entry) => entry.id === run!.id);
    const destinations = await db.select().from(companies);
    expect(saved?.companyId).toBe(first.id);
    expect(destinations.some((company) => company.id === first.id)).toBe(true);
    expect(destinations.some((company) => company.name === "Second provenance destination")).toBe(false);
  });

  it("allows only one concurrent destination to claim a transfer run", async () => {
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "applying", actorKey: "migration-test",
      idempotencyKey: "provenance-concurrent-destination", containerRef: {},
    }).returning();
    const service = companyService(db);
    const results = await Promise.allSettled([
      service.create({ name: "Concurrent provenance first" }, { transferRunId: run!.id }),
      service.create({ name: "Concurrent provenance second" }, { transferRunId: run!.id }),
    ]);
    const successful = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter((result) => result.status === "rejected");
    expect(successful).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const saved = (await db.select().from(companyTransferRuns)).find((entry) => entry.id === run!.id);
    const destinations = (await db.select().from(companies)).filter((company) =>
      company.name === "Concurrent provenance first" || company.name === "Concurrent provenance second");
    expect(destinations).toHaveLength(1);
    expect(saved?.companyId).toBe(destinations[0]!.id);
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

  it("does not attach a new destination to an export transfer run", async () => {
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "export", status: "applying", actorKey: "migration-test",
      idempotencyKey: "provenance-export-rejected", containerRef: {},
    }).returning();
    await expect(companyService(db).create({ name: "Export provenance destination" }, { transferRunId: run!.id }))
      .rejects.toThrow("Transfer run cannot claim a new company");
    expect((await db.select().from(companies)).some((company) => company.name === "Export provenance destination")).toBe(false);
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
      expect(insert).toHaveBeenCalledWith(companyMemberships);
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

  it("recovers a partial import after agent creation without touching the source", async () => {
    const [source] = await db.insert(companies).values({ name: "Partial import source", issuePrefix: "MPI" }).returning();
    const [worker] = await db.insert(agents).values({ companyId: source!.id, name: "Partial import worker" }).returning();
    await db.insert(projects).values({ companyId: source!.id, name: "Partial import project" });
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
      if (table === projects) throw new Error("injected project failure");
      return originalInsert(table);
    }) as typeof db.insert);
    try {
      const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
        target: { mode: "new_company", newCompanyName: "Partial import destination" },
        export: { include: { projects: true } },
        dryRun: false, apply: true, confirm: "approved pilot",
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(insert).toHaveBeenCalledWith(projects);
    } finally {
      insert.mockRestore();
    }

    const destination = (await db.select().from(companies)).find((company) => company.name === "Partial import destination");
    expect(destination).toBeDefined();
    const run = (await db.select().from(companyTransferRuns)).find((entry) => entry.companyId === destination!.id);
    expect(run?.status).toBe("failed");
    expect((await db.select().from(agents)).some((agent) => agent.companyId === destination!.id)).toBe(true);
    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${run!.id}/rollback`)
      .send({ confirm: "recover partial import" });
    expect(rollback.status).toBe(200);
    const remainingAgents = await db.select().from(agents);
    expect(remainingAgents.some((agent) => agent.companyId === destination!.id)).toBe(false);
    expect(remainingAgents.some((agent) => agent.id === worker!.id && agent.companyId === source!.id)).toBe(true);
    expect((await db.select().from(projects)).some((project) => project.companyId === source!.id)).toBe(true);
  });

  it("removes imported logo storage after a partial failure without touching the source logo", async () => {
    const [source] = await db.insert(companies).values({ name: "Logo recovery source", issuePrefix: "MLR" }).returning();
    await db.insert(projects).values({ companyId: source!.id, name: "Logo recovery project" });
    const storage = createStorageService(createLocalDiskStorageProvider(root));
    const original = await storage.putFile({
      companyId: source!.id, namespace: "assets/companies", originalFilename: "logo.png",
      contentType: "image/png", body: Buffer.from("source-logo"),
    });
    const [asset] = await db.insert(assets).values({ companyId: source!.id, ...original }).returning();
    await db.insert(companyLogos).values({ companyId: source!.id, assetId: asset!.id });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, storage));
    app.use(errorHandler);

    const originalInsert = db.insert.bind(db);
    const insert = vi.spyOn(db, "insert").mockImplementation(((table: Parameters<typeof db.insert>[0]) => {
      if (table === projects) throw new Error("injected project failure after logo import");
      return originalInsert(table);
    }) as typeof db.insert);
    const putFile = vi.spyOn(storage, "putFile");
    try {
      const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
        target: { mode: "new_company", newCompanyName: "Logo recovery destination" },
        export: { include: { projects: true } },
        dryRun: false, apply: true, confirm: "approved pilot",
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(insert).toHaveBeenCalledWith(projects);
    } finally {
      insert.mockRestore();
    }

    expect(putFile).toHaveBeenCalledTimes(1);
    const imported = await putFile.mock.results[0]!.value;
    putFile.mockRestore();
    const destination = (await db.select().from(companies)).find((company) => company.name === "Logo recovery destination");
    expect(destination).toBeDefined();
    const run = (await db.select().from(companyTransferRuns)).find((entry) => entry.companyId === destination!.id);
    expect(run?.status).toBe("failed");
    expect((await storage.headObject(destination!.id, imported.objectKey)).exists).toBe(true);
    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${run!.id}/rollback`)
      .send({ confirm: "recover partial logo import" });
    expect(rollback.status).toBe(200);
    expect((await storage.headObject(destination!.id, imported.objectKey)).exists).toBe(false);
    expect((await storage.headObject(source!.id, original.objectKey)).exists).toBe(true);
    expect((await db.select().from(assets)).some((entry) => entry.id === asset!.id)).toBe(true);
  });

  it("recovers a logo uploaded before its asset record could be created", async () => {
    const [source] = await db.insert(companies).values({ name: "Orphan logo source", issuePrefix: "MOL" }).returning();
    const storage = createStorageService(createLocalDiskStorageProvider(root));
    const original = await storage.putFile({
      companyId: source!.id, namespace: "assets/companies", originalFilename: "logo.png",
      contentType: "image/png", body: Buffer.from("original logo"),
    });
    const [asset] = await db.insert(assets).values({ companyId: source!.id, ...original }).returning();
    await db.insert(companyLogos).values({ companyId: source!.id, assetId: asset!.id });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, storage));
    app.use(errorHandler);

    const originalInsert = db.insert.bind(db);
    const insert = vi.spyOn(db, "insert").mockImplementation(((table: Parameters<typeof db.insert>[0]) => {
      if (table === assets) throw new Error("injected asset record failure");
      return originalInsert(table);
    }) as typeof db.insert);
    const putFile = vi.spyOn(storage, "putFile");
    try {
      const response = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
        target: { mode: "new_company", newCompanyName: "Orphan logo destination" },
        dryRun: false, apply: true, confirm: "approved pilot",
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(insert).toHaveBeenCalledWith(assets);
    } finally {
      insert.mockRestore();
    }

    expect(putFile).toHaveBeenCalledTimes(1);
    const uploaded = await putFile.mock.results[0]!.value;
    putFile.mockRestore();
    const destination = (await db.select().from(companies)).find((company) => company.name === "Orphan logo destination");
    expect(destination).toBeDefined();
    const run = (await db.select().from(companyTransferRuns)).find((entry) => entry.companyId === destination!.id);
    expect(run?.status).toBe("failed");
    expect((await storage.headObject(destination!.id, uploaded.objectKey)).exists).toBe(true);
    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${run!.id}/rollback`)
      .send({ confirm: "recover orphan logo" });
    expect(rollback.status).toBe(200);
    expect((await storage.headObject(destination!.id, uploaded.objectKey)).exists).toBe(false);
    expect((await storage.headObject(source!.id, original.objectKey)).exists).toBe(true);
    expect((await db.select().from(assets)).some((entry) => entry.id === asset!.id)).toBe(true);
  });

  it("requires confirmation for rollback and removes only the migrated company", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback fixture", issuePrefix: "RBF" }).returning();
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

  it("refuses rollback when destination company settings changed after migration", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback company change source", issuePrefix: "RCC" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Rollback company change destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const run = await companyTransferRunService.getRun(db, applied.body.runId);
    expect(run?.companyId).toBeTruthy();
    await db.update(companies).set({ description: "independent change", updatedAt: new Date() })
      .where(eq(companies.id, run!.companyId!));
    const beforeCompanies = await db.select().from(companies);
    const beforeRuns = await db.select().from(companyTransferRuns);

    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${run!.id}/rollback`)
      .send({ confirm: "rollback pilot" });
    expect(rollback.status).toBe(409);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
  });

  it("does not remove agents created independently after migration", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback ownership source", issuePrefix: "MOW" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Rollback ownership destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const destination = (await db.select().from(companies)).find((company) => company.name === "Rollback ownership destination")!;
    const [independent] = await db.insert(agents).values({ companyId: destination.id, name: "Independent agent" }).returning();
    const before = await db.select().from(agents);

    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${applied.body.runId}/rollback`)
      .send({ confirm: "rollback pilot" });
    expect(rollback.status).toBe(409);
    expect(await db.select().from(agents)).toEqual(before);
    expect((await db.select().from(companies)).find((company) => company.id === destination.id)?.status).not.toBe("archived");
    expect(before.some((agent) => agent.id === independent!.id)).toBe(true);
  });

  it("refuses rollback when an independent membership and grant were added to the destination", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback ACL ownership source", issuePrefix: "RAO" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Rollback ACL ownership destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const destination = (await db.select().from(companies)).find((company) => company.name === "Rollback ACL ownership destination")!;
    await db.insert(companyMemberships).values({
      companyId: destination.id, principalType: "user", principalId: "independent-user", membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId: destination.id, principalType: "user", principalId: "independent-user", permissionKey: "tasks:assign",
    });
    const beforeCompanies = await db.select().from(companies);
    const beforeMemberships = await db.select().from(companyMemberships);
    const beforeGrants = await db.select().from(principalPermissionGrants);
    const beforeRuns = await db.select().from(companyTransferRuns);

    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${applied.body.runId}/rollback`)
      .send({ confirm: "rollback pilot" });
    expect(rollback.status).toBe(409);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(companyMemberships)).toEqual(beforeMemberships);
    expect(await db.select().from(principalPermissionGrants)).toEqual(beforeGrants);
    expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
  });

  it("refuses rollback when an independent task was created in the destination", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback task ownership source", issuePrefix: "MTO" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Rollback task ownership destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const destination = (await db.select().from(companies)).find((company) => company.name === "Rollback task ownership destination")!;
    const [independent] = await db.insert(issues).values({ companyId: destination.id, title: "Independent task" }).returning();
    const beforeCompanies = await db.select().from(companies);
    const beforeIssues = await db.select().from(issues);
    const beforeRuns = await db.select().from(companyTransferRuns);

    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${applied.body.runId}/rollback`)
      .send({ confirm: "rollback pilot" });
    expect(rollback.status).toBe(409);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(issues)).toEqual(beforeIssues);
    expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
    expect(beforeIssues.some((issue) => issue.id === independent!.id)).toBe(true);
  });

  it("refuses rollback when an independent project was created in the destination", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback project ownership source", issuePrefix: "MPO" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Rollback project ownership destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const destination = (await db.select().from(companies)).find((company) => company.name === "Rollback project ownership destination")!;
    const [independent] = await db.insert(projects).values({ companyId: destination.id, name: "Independent project" }).returning();
    const beforeCompanies = await db.select().from(companies);
    const beforeProjects = await db.select().from(projects);
    const beforeRuns = await db.select().from(companyTransferRuns);

    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${applied.body.runId}/rollback`)
      .send({ confirm: "rollback pilot" });
    expect(rollback.status).toBe(409);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(projects)).toEqual(beforeProjects);
    expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
    expect(beforeProjects.some((project) => project.id === independent!.id)).toBe(true);
  });

  it("refuses rollback when an independent asset was added to the destination", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback asset ownership source", issuePrefix: "MAO" }).returning();
    const storage = createStorageService(createLocalDiskStorageProvider(root));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, storage));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Rollback asset ownership destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const destination = (await db.select().from(companies)).find((company) => company.name === "Rollback asset ownership destination")!;
    const stored = await storage.putFile({
      companyId: destination.id, namespace: "assets/general", originalFilename: "independent.png",
      contentType: "image/png", body: Buffer.from("independent asset"),
    });
    const [independent] = await db.insert(assets).values({ companyId: destination.id, ...stored }).returning();
    const beforeCompanies = await db.select().from(companies);
    const beforeAssets = await db.select().from(assets);
    const beforeRuns = await db.select().from(companyTransferRuns);

    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${applied.body.runId}/rollback`)
      .send({ confirm: "rollback pilot" });
    expect(rollback.status).toBe(409);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(assets)).toEqual(beforeAssets);
    expect(await db.select().from(companyTransferRuns)).toEqual(beforeRuns);
    expect(beforeAssets.some((asset) => asset.id === independent!.id)).toBe(true);
    expect((await storage.headObject(destination.id, stored.objectKey)).exists).toBe(true);
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

  it("refuses rollback when a migrated issue was modified after import", async () => {
    const [source] = await db.insert(companies).values({ name: "Modified issue source", issuePrefix: "MMI" }).returning();
    await db.insert(issues).values({ companyId: source!.id, title: "Original issue" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Modified issue destination" },
      export: { include: { issues: true } },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const destination = (await db.select().from(companies)).find((company) => company.name === "Modified issue destination")!;
    const copied = (await db.select().from(issues)).find((issue) => issue.companyId === destination.id)!;
    const { eq } = await import("drizzle-orm");
    await db.update(issues).set({ title: "Modified issue", updatedAt: new Date(copied.createdAt.getTime() + 60_000) })
      .where(eq(issues.id, copied.id));
    const beforeCompanies = await db.select().from(companies);
    const beforeIssues = await db.select().from(issues);

    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${applied.body.runId}/rollback`)
      .send({ confirm: "rollback pilot" });
    expect(rollback.status).toBe(409);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(issues)).toEqual(beforeIssues);
  });

  it("refuses rollback when a migrated project was modified after import", async () => {
    const [source] = await db.insert(companies).values({ name: "Modified project source", issuePrefix: "MMP" }).returning();
    await db.insert(projects).values({ companyId: source!.id, name: "Original project" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Modified project destination" },
      export: { include: { projects: true } },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const destination = (await db.select().from(companies)).find((company) => company.name === "Modified project destination")!;
    const copied = (await db.select().from(projects)).find((project) => project.companyId === destination.id)!;
    const { eq } = await import("drizzle-orm");
    await db.update(projects).set({ name: "Modified project", updatedAt: new Date(copied.createdAt.getTime() + 60_000) })
      .where(eq(projects.id, copied.id));
    const beforeCompanies = await db.select().from(companies);
    const beforeProjects = await db.select().from(projects);

    const rollback = await request(app)
      .post(`/api/companies/${source!.id}/migrations/${applied.body.runId}/rollback`)
      .send({ confirm: "rollback pilot" });
    expect(rollback.status).toBe(409);
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(projects)).toEqual(beforeProjects);
  });

  it("rejects rollback of a migration through a different source company", async () => {
    const [source] = await db.insert(companies).values({ name: "Rollback source", issuePrefix: "RBS" }).returning();
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

  it("exposes only source-scoped migration ledger status without transfer details", async () => {
    const [source] = await db.insert(companies).values({ name: "Ledger source", issuePrefix: "MLS" }).returning();
    const [other] = await db.insert(companies).values({ name: "Ledger other", issuePrefix: "MLO" }).returning();
    const [run] = await db.insert(companyTransferRuns).values({
      direction: "import", status: "failed", actorKey: "migration-test", idempotencyKey: "status-scope",
      containerRef: { kind: "company_migration", sourceCompanyId: source!.id }, error: "private diagnostic",
    }).returning();
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id, other!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const result = await request(app).get(`/api/companies/${source!.id}/migrations/${run!.id}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ runId: run!.id, status: "failed" });
    expect((await request(app).get(`/api/companies/${other!.id}/migrations/${run!.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/companies/${source!.id}/migrations/not-a-uuid`)).status).toBe(404);
  });

  it("returns migration status only through its source company", async () => {
    const [source] = await db.insert(companies).values({ name: "Status source", issuePrefix: "RSE" }).returning();
    const [other] = await db.insert(companies).values({ name: "Status other", issuePrefix: "RSO" }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [source!.id, other!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const applied = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "new_company", newCompanyName: "Status destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    });
    expect(applied.status).toBe(200);
    const status = await request(app).get(`/api/companies/${source!.id}/migrations/${applied.body.runId}`);
    expect(status.status).toBe(200);
    expect(status.body.runId).toBe(applied.body.runId);
    expect(status.body.status).toBe("completed");
    const wrongSource = await request(app).get(`/api/companies/${other!.id}/migrations/${applied.body.runId}`);
    expect([403, 404]).toContain(wrongSource.status);
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

  it("does not duplicate a completed migration when a different operator retries it", async () => {
    const [source] = await db.insert(companies).values({ name: "Operator retry source", issuePrefix: "MOR" }).returning();
    const app = express();
    let operator = "first-operator";
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: operator, source: "local_implicit", companyIds: [source!.id], isInstanceAdmin: false };
      next();
    });
    app.use("/api/companies", companyRoutes(db, createStorageService(createLocalDiskStorageProvider(root))));
    app.use(errorHandler);

    const endpoint = `/api/companies/${source!.id}/migrations`;
    const payload = {
      target: { mode: "new_company", newCompanyName: "Operator retry destination" },
      dryRun: false, apply: true, confirm: "approved pilot",
    };
    const first = await request(app).post(endpoint).send(payload);
    expect(first.status).toBe(200);
    operator = "second-operator";
    const second = await request(app).post(endpoint).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.resume).toBe("already_completed");
    expect(second.body.runId).toBe(first.body.runId);
    expect((await db.select().from(companies)).filter((company) => company.name === "Operator retry destination")).toHaveLength(1);
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
