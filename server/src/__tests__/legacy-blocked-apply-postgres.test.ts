import { randomUUID } from "node:crypto";
import { asc } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  closeRegisteredClients,
  companies,
  createDb,
  issueRelations,
  issues,
  legacyBlockedImports,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runLegacyBlockedApply } from "../../../scripts/myrmidon/legacy-blocked/apply.js";
import { runLegacyBlockedDryRun } from "../../../scripts/myrmidon/legacy-blocked/dry-run.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("legacy blocked apply postgres", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-legacy-blocked-apply-");
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
    if (tempDb) {
      await closeRegisteredClients(tempDb.connectionString);
      await tempDb.cleanup();
    }
  });

  async function snapshot() {
    return {
      issues: await db.select().from(issues).orderBy(asc(issues.id)),
      relations: await db.select().from(issueRelations).orderBy(asc(issueRelations.id)),
      journal: await db.select().from(legacyBlockedImports).orderBy(asc(legacyBlockedImports.importKey)),
    };
  }

  it("classifies and applies PostgreSQL fixtures losslessly and idempotently", async () => {
    const companyId = randomUUID();
    const ownerId = randomUUID();
    const recoveryId = randomUUID();
    const dependencyId = randomUUID();
    const unknownId = randomUUID();
    const terminalId = randomUUID();
    const blockerId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "legacy-blocked-apply-test", issuePrefix: "LBA" });
    await db.insert(agents).values({ id: ownerId, companyId, name: "Legacy Apply Owner", role: "engineer", status: "active" });
    await db.insert(issues).values([
      { id: recoveryId, companyId, identifier: "LBA-1", title: "Recovery source", status: "blocked", priority: "high", assigneeAgentId: ownerId, description: "recovery task is required" },
      { id: dependencyId, companyId, identifier: "LBA-2", title: "Dependency source", status: "blocked", priority: "high", assigneeAgentId: ownerId },
      { id: unknownId, companyId, identifier: "LBA-3", title: "Unknown source", status: "blocked", priority: "high", description: "unrecognized condition" },
      { id: terminalId, companyId, identifier: "LBA-4", title: "Terminal source", status: "blocked", priority: "high", assigneeAgentId: ownerId, description: "duplicate" },
      { id: blockerId, companyId, identifier: "LBA-5", title: "Explicit blocker", status: "done", priority: "high", assigneeAgentId: ownerId },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: blockerId, relatedIssueId: dependencyId, type: "blocks" },
    ]);

    const dryRun = await runLegacyBlockedDryRun(db);
    const classes = new Map(dryRun.report.rows.map((row) => [row.issueId, row.class]));
    expect(classes.get(recoveryId)).toBe("recovery");
    expect(classes.get(dependencyId)).toBe("dependency");
    expect(classes.get(unknownId)).toBe("unknown");
    expect(classes.get(terminalId)).toBe("terminal");

    const before = await snapshot();
    const dryRunResult = await runLegacyBlockedApply(db);
    expect(dryRunResult.changed).toBe(0);
    expect(await snapshot()).toEqual(before);

    const first = await runLegacyBlockedApply(db, { apply: true });
    expect(first.rows.find((row) => row.issueId === recoveryId)?.outcome).toBe("applied");
    expect(first.rows.find((row) => row.issueId === dependencyId)?.outcome).toBe("applied");
    expect(first.rows.find((row) => row.issueId === unknownId)?.outcome).toBe("skipped");
    expect(first.rows.find((row) => row.issueId === terminalId)?.outcome).toBe("skipped");
    expect(first.changed).toBe(2);

    const afterFirst = await snapshot();
    expect(afterFirst.issues.filter((issue) => [recoveryId, dependencyId, unknownId, terminalId, blockerId].includes(issue.id))).toHaveLength(5);
    expect(afterFirst.relations).toEqual(before.relations);
    expect(afterFirst.issues).toHaveLength(before.issues.length + 1);
    expect(afterFirst.issues.find((issue) => issue.id === dependencyId)?.blockerMetadata)
      .toMatchObject({ blockReason: "dependency", blockedByIssueIds: [blockerId], owner: { agentId: ownerId } });
    expect(afterFirst.journal).toHaveLength(2);

    const second = await runLegacyBlockedApply(db, { apply: true });
    expect(second.changed).toBe(0);
    expect(second.rows.filter((row) => row.outcome === "already_applied")).toHaveLength(2);
    expect(await snapshot()).toEqual(afterFirst);
  }, 90_000);
});