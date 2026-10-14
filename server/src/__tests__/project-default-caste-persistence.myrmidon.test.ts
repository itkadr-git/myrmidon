import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentCastes, companies, createDb, projects as projectsTable } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService } from "../services/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project default caste tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Verifies the PAP-69 data layer: the 0094 migration applies cleanly (the
// embedded harness runs all pending migrations on startup) and the `icon`
// column persists + round-trips through the projects service.
describeEmbeddedPostgres("project default caste persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let prefixCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-icon-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(projectsTable);
    await db.delete(agentCastes);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: "Icon Co", issuePrefix: `ICN${prefixCounter}` })
      .returning();
    return company.id;
  }

  it("persists, preserves omitted patches, and clears the default", async () => {
    companyId = await seedCompany();
    const service = projectService(db);
    const created = await service.create(companyId, { name: "Project" });
    expect(created.defaultCasteKey).toBeNull();
    expect((await service.update(created.id, { defaultCasteKey: "engineer" }))?.defaultCasteKey).toBe("engineer");
    await service.update(created.id, { description: "changed" });
    expect((await service.getById(created.id))?.defaultCasteKey).toBe("engineer");
    expect((await service.list(companyId))[0].defaultCasteKey).toBe("engineer");
    expect((await service.update(created.id, { defaultCasteKey: null }))?.defaultCasteKey).toBeNull();
  });
  it("rejects unknown and foreign-company castes", async () => {
    companyId = await seedCompany();
    const other = await seedCompany();
    await db.insert(agentCastes).values({ companyId: other, key: "foreign", nameEn: "Foreign", nameRu: "Foreign", color: "gray" });
    const service = projectService(db);
    const created = await service.create(companyId, { name: "Project" });
    for (const key of ["missing", "foreign"]) {
      await expect(service.update(created.id, { defaultCasteKey: key })).rejects.toMatchObject({ status: 422 });
    }
    expect((await service.getById(created.id))?.defaultCasteKey).toBeNull();
  });
  it("replays and reverses the additive migration", async () => {
    const migration = readFileSync(new URL("../../../packages/db/src/migrations/0317_project_default_caste.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(migration));
    await db.execute(sql.raw(migration));
    await db.execute(sql.raw('ALTER TABLE projects DROP COLUMN IF EXISTS default_caste_key'));
    await db.execute(sql.raw(migration));
    const created = await projectService(db).create(await seedCompany(), { name: "Restored" });
    expect(created.defaultCasteKey).toBeNull();
  });
});
