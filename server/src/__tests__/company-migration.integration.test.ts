import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, companyTransferRuns, createDb, issues, projects } from "@myrmidon/db";

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
    }
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
    await companyTransferRunService.complete(db, first.run.id);
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
    const [source] = await db.insert(companies).values({ name: "Status source", issuePrefix: "MST" }).returning();
    const [other] = await db.insert(companies).values({ name: "Status other", issuePrefix: "MSO" }).returning();
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
