import { randomUUID } from "node:crypto";
import { asc } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, closeRegisteredClients, companies, createDb, issueRelations, issues, legacyBlockedImports } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { runLegacyBlockedApply } from "../../../scripts/myrmidon/legacy-blocked/apply.js";
import { runLegacyBlockedDryRun } from "../../../scripts/myrmidon/legacy-blocked/dry-run.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("legacy blocked reconciliation postgres", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-legacy-blocked-reconciliation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(legacyBlockedImports);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (!tempDb) return;
    await closeRegisteredClients(tempDb.connectionString);
    await tempDb.cleanup();
  });

  async function snapshot() {
    return {
      issues: await db.select().from(issues).orderBy(asc(issues.id)),
      relations: await db.select().from(issueRelations).orderBy(asc(issueRelations.id)),
      journal: await db.select().from(legacyBlockedImports).orderBy(asc(legacyBlockedImports.importKey)),
    };
  }

  it("reconciles at least 46 legacy blocked tasks losslessly and idempotently", async () => {
    const companyId = randomUUID();
    const ownerId = randomUUID();
    const ids = Array.from({ length: 46 }, () => randomUUID());
    await db.insert(companies).values({ id: companyId, name: "legacy-blocked-reconciliation-test", issuePrefix: "LBR" });
    await db.insert(agents).values({ id: ownerId, companyId, name: "Legacy Reconciliation Owner", role: "engineer", status: "active" });

    await db.insert(issues).values(ids.map((id, index) => ({
      id,
      companyId,
      identifier: `LBR-${index + 1}`,
      title: index === 45 ? "Unrecognized blocked record" : `Recovery source ${index + 1}`,
      status: "blocked" as const,
      priority: "high" as const,
      assigneeAgentId: ownerId,
      description: index === 45 ? "no recognized legacy classification" : "recovery task is required",
    })));

    const dryRun = await runLegacyBlockedDryRun(db);
    expect(dryRun.report.rows).toHaveLength(46);
    expect(dryRun.report.totals).toMatchObject({ unknown: 1, recovery: 45 });
    expect(Object.values(dryRun.report.totals).reduce((sum, count) => sum + count, 0)).toBe(46);
    expect(dryRun.report.unknown).toHaveLength(1);
    expect(dryRun.report.lost).toHaveLength(0);

    const before = await snapshot();
    const dryApply = await runLegacyBlockedApply(db);
    expect(dryApply.changed).toBe(0);
    expect(await snapshot()).toEqual(before);

    const first = await runLegacyBlockedApply(db, { apply: true });
    expect(first.rows).toHaveLength(46);
    expect(first.changed).toBe(45);
    expect(first.rows.filter((row) => row.class === "unknown")).toHaveLength(1);
    expect(first.rows.find((row) => row.class === "unknown")?.outcome).toBe("skipped");
    expect(first.rows.filter((row) => row.outcome === "applied")).toHaveLength(45);

    const afterFirst = await snapshot();
    expect(afterFirst.issues.filter((issue) => ids.includes(issue.id))).toHaveLength(46);
    expect(afterFirst.relations).toEqual(before.relations);
    expect(afterFirst.issues).toHaveLength(before.issues.length + 45);
    expect(afterFirst.journal).toHaveLength(45);

    const second = await runLegacyBlockedApply(db, { apply: true });
    expect(second.changed).toBe(0);
    expect(second.rows.filter((row) => row.outcome === "already_applied")).toHaveLength(45);
    expect(await snapshot()).toEqual(afterFirst);
  }, 90_000);
});
