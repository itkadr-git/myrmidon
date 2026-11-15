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
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await db.select().from(companies)).toEqual(beforeCompanies);
    expect(await db.select().from(activityLog)).toEqual(beforeAudit);
    expect(await readdir(root, { recursive: true })).toEqual(filesBefore);
    insert.mockRestore(); update.mockRestore(); remove.mockRestore();
  });
});
