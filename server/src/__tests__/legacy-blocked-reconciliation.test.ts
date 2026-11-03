import { randomUUID } from "node:crypto";
import { asc } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  closeRegisteredClients,
  companies,
  createDb,
  issues,
  legacyBlockedImports,
} from "@myrmidon/db";
import { createLegacyBlockedImportKey } from "@myrmidon/shared";
import { buildReconciliationReport } from "../../../scripts/myrmidon/legacy-blocked/report.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres legacy blocked reconciliation test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("legacy blocked reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-legacy-blocked-reconciliation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(legacyBlockedImports);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (tempDb) {
      await closeRegisteredClients(tempDb.connectionString);
      await tempDb.cleanup();
    }
  });

  it("reconciles 46+ issues without loss, isolates unknown, and makes repeated imports idempotent", async () => {
    const companyId = randomUUID();
    const taskCount = 48;
    const tasks = Array.from({ length: taskCount }, (_, index) => ({
      id: randomUUID(),
      identifier: `OPE-FIXTURE-${String(index + 1).padStart(2, "0")}`,
      title: `Legacy blocked fixture ${index + 1}`,
      status: "blocked",
    }));

    await db.insert(companies).values({
      id: companyId,
      name: "Legacy blocked reconciliation fixture",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values(tasks.map(({ id, title, status }) => ({
      id,
      companyId,
      title,
      status,
    })));

    const inventory = tasks.map(({ id, identifier, status }) => ({ id, identifier, status }));
    const results = tasks.map((task, index) => ({
      issueId: task.id,
      class: index === 47 ? "unknown" : "dependency",
      evidence: index === 47 ? ["Classification evidence is insufficient."] : [`Waiting on dependency ${index + 1}.`],
      ...(index === 47 ? {} : { proposedOwner: "legacy-reconciliation" }),
      importKey: createLegacyBlockedImportKey(task.id),
    }));

    const firstReport = buildReconciliationReport(inventory, results);
    expect(firstReport.rows).toHaveLength(taskCount);
    expect(firstReport.lost).toEqual([]);
    expect(firstReport.unknown).toHaveLength(1);
    expect(firstReport.unknown[0].issueId).toBe(tasks[47].id);
    expect(firstReport.totals.dependency).toBe(taskCount - 1);
    expect(firstReport.totals.unknown).toBe(1);
    expect(Object.values(firstReport.totals).reduce((sum, count) => sum + count, 0)).toBe(taskCount);

    const importRows = firstReport.rows.map((row) => ({
      companyId,
      importKey: row.importKey,
      issueId: row.issueId,
      class: row.class,
    }));
    await db.insert(legacyBlockedImports).values(importRows).onConflictDoNothing();
    const firstImport = await db.select().from(legacyBlockedImports).orderBy(asc(legacyBlockedImports.importKey));
    expect(firstImport).toHaveLength(taskCount);

    const secondReport = buildReconciliationReport(inventory, results);
    expect(secondReport.json).toBe(firstReport.json);
    await db.insert(legacyBlockedImports).values(
      secondReport.rows.map((row) => ({
        companyId,
        importKey: row.importKey,
        issueId: row.issueId,
        class: row.class,
      })),
    ).onConflictDoNothing();

    const repeatedImport = await db.select().from(legacyBlockedImports).orderBy(asc(legacyBlockedImports.importKey));
    expect(repeatedImport).toEqual(firstImport);
    expect(repeatedImport).toHaveLength(taskCount);
  });
});
