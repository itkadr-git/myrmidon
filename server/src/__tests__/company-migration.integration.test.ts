import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb } from "@myrmidon/db";

import { companyRoutes } from "../routes/companies.js";
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
    const storage = createStorageService(createLocalDiskStorageProvider(root));
    const insert = vi.spyOn(db, "insert");
    const update = vi.spyOn(db, "update");
    const remove = vi.spyOn(db, "delete");
    const beforeCompanies = await db.select().from(companies);
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
    });
    expect(response.status).toBe(200);
    expect(response.body.dryRun).toBe(true);
    expect(response.body.validation.errors).toEqual([]);

    const existingTarget = await request(app).post(`/api/companies/${source!.id}/migrations`).send({
      target: { mode: "existing_company", companyId: source!.id },
    });
    expect(existingTarget.status).toBe(400);

    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(activityLog)).toEqual(beforeAudit);
    expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
    insert.mockRestore(); update.mockRestore(); remove.mockRestore();
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
    expect(afterFirst.filter((company) => company.name === "Apply destination")).toHaveLength(1);

    const second = await request(app).post(`/api/companies/${source!.id}/migrations`).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.resume).toBe("already_completed");
    expect(await db.select().from(companies)).toEqual(afterFirst);
  });
});
