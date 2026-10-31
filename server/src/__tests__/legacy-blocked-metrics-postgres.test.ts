import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeRegisteredClients, companies, createDb, issues, legacyBlockedImports } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { collectLegacyBlockedMetrics, legacyBlockedReadPort, renderLegacyBlockedMetrics } from "../myrmidon/monitoring/metrics/legacy-blocked.js";

const support = await getEmbeddedPostgresTestSupport();
// CI must fail, not silently accept an unexecuted PG acceptance test.
if (process.env.CI && !support.supported) throw new Error(`L5 PG acceptance unavailable: ${support.reason}`);
const pgDescribe = support.supported ? describe : describe.skip;

pgDescribe("legacy blocked metrics PostgreSQL journal fixture", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-legacy-metrics-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    if (tempDb) {
      await closeRegisteredClients(tempDb.connectionString);
      await tempDb.cleanup();
    }
  });

  it("reads persisted L5 rows with original issue age and duplicate telemetry, rendering all five families", async () => {
    await db.transaction(async (tx) => {
      const company = randomUUID();
      const otherCompany = randomUUID();
      await tx.insert(companies).values([
        { id: company, name: "L5 metrics", issuePrefix: "LGM" },
        { id: otherCompany, name: "L5 metrics tenant boundary", issuePrefix: "LGT" },
      ]);

      const now = new Date("2026-10-27T12:00:00Z");

      // 1. Fully migrated row (dependency with resultIssueId): created 20000s ago in issues.
      // Since it is migrated, it must NOT contribute to remainingAgeSeconds.
      const migratedIssueId = randomUUID();
      const resultIssueId = randomUUID();
      await tx.insert(issues).values([
        { id: migratedIssueId, companyId: company, title: "Migrated issue", status: "blocked", createdAt: new Date(now.getTime() - 20000 * 1000) },
        { id: resultIssueId, companyId: company, title: "Result issue" },
      ]);
      await tx.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "migrated-dep",
        issueId: migratedIssueId,
        class: "dependency",
        resultIssueId,
        createdAt: new Date("2026-10-27T11:00:00Z"),
      });

      // 2. Terminal row (class terminal): created 18000s ago in issues.
      // Terminal rows require no result issue and count as migrated; must NOT contribute to remainingAgeSeconds.
      const terminalIssueId = randomUUID();
      await tx.insert(issues).values({ id: terminalIssueId, companyId: company, title: "Terminal issue", status: "blocked", createdAt: new Date(now.getTime() - 18000 * 1000) });
      await tx.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "terminal-row",
        issueId: terminalIssueId,
        class: "terminal",
        resultIssueId: null,
        createdAt: new Date("2026-10-27T11:00:00Z"),
      });

      // 3. Unmigrated remaining items of multiple classes with distinct creation times:
      // - Oldest remaining dependency: 14400s (4 hours)
      const oldestRemainingDepId = randomUUID();
      await tx.insert(issues).values({ id: oldestRemainingDepId, companyId: company, title: "Remaining dep", status: "blocked", createdAt: new Date(now.getTime() - 14400 * 1000) });
      await tx.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "rem-dep",
        issueId: oldestRemainingDepId,
        class: "dependency",
        resultIssueId: null,
        createdAt: new Date("2026-10-27T11:00:00Z"),
      });

      // - Remaining recovery: 7200s (2 hours)
      const remainingRecId = randomUUID();
      await tx.insert(issues).values({ id: remainingRecId, companyId: company, title: "Remaining rec", status: "blocked", createdAt: new Date(now.getTime() - 7200 * 1000) });
      await tx.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "rem-rec",
        issueId: remainingRecId,
        class: "recovery",
        resultIssueId: null,
        createdAt: new Date("2026-10-27T11:00:00Z"),
      });

      // - Remaining unknown: 3600s (1 hour)
      const remainingUnkId = randomUUID();
      await tx.insert(issues).values({ id: remainingUnkId, companyId: company, title: "Remaining unk", status: "blocked", createdAt: new Date(now.getTime() - 3600 * 1000) });
      await tx.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "rem-unk",
        issueId: remainingUnkId,
        class: "unknown",
        resultIssueId: null,
        createdAt: new Date("2026-10-27T11:00:00Z"),
      });

      // - Remaining human_decision: 600s (10 min)
      const remainingHumId = randomUUID();
      await tx.insert(issues).values({ id: remainingHumId, companyId: company, title: "Remaining hum", status: "blocked", createdAt: new Date(now.getTime() - 600 * 1000) });
      await tx.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "rem-hum",
        issueId: remainingHumId,
        class: "human_decision",
        resultIssueId: null,
        createdAt: new Date("2026-10-27T11:00:00Z"),
      });

      // - Other company unmigrated item: 1200s
      const otherIssueId = randomUUID();
      await tx.insert(issues).values({ id: otherIssueId, companyId: otherCompany, title: "Other dep", status: "blocked", createdAt: new Date(now.getTime() - 1200 * 1000) });
      await tx.insert(legacyBlockedImports).values({
        companyId: otherCompany,
        importKey: "other-dep",
        issueId: otherIssueId,
        class: "dependency",
        resultIssueId: null,
        createdAt: new Date("2026-10-27T11:00:00Z"),
      });

      // 4. Duplicate import records in journal:
      // Insert duplicate rows for already imported issues under distinct import_keys.
      // - Duplicate row 1: re-import of oldestRemainingDepId with different key
      await tx.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "dup-dep-key",
        issueId: oldestRemainingDepId,
        class: "dependency",
        resultIssueId: null,
        createdAt: new Date("2026-10-27T11:30:00Z"),
      });
      // - Duplicate row 2: re-import of remainingRecId with different key
      await tx.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "dup-rec-key",
        issueId: remainingRecId,
        class: "recovery",
        resultIssueId: null,
        createdAt: new Date("2026-10-27T11:30:00Z"),
      });

      // - Duplicate row 3: issue initially imported as unknown without result,
      // then secondary row arrives with resultIssueId resolving it.
      const dupResolvedIssueId = randomUUID();
      const dupResolutionResultId = randomUUID();
      await tx.insert(issues).values([
        { id: dupResolvedIssueId, companyId: company, title: "Dup resolved issue", status: "blocked", createdAt: new Date(now.getTime() - 5000 * 1000) },
        { id: dupResolutionResultId, companyId: company, title: "Dup resolution result" },
      ]);
      await tx.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "dup-res-initial",
        issueId: dupResolvedIssueId,
        class: "unknown",
        resultIssueId: null,
        createdAt: new Date("2026-10-27T10:00:00Z"),
      });
      await tx.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "dup-res-secondary",
        issueId: dupResolvedIssueId,
        class: "recovery",
        resultIssueId: dupResolutionResultId,
        createdAt: new Date("2026-10-27T11:45:00Z"),
      });

      const port = legacyBlockedReadPort(tx as unknown as ReturnType<typeof createDb>);
      const sample = await collectLegacyBlockedMetrics(port, now);

      expect(sample).toEqual({
        migrated: 3, // 1 dependency with result + 1 terminal + 1 dupResolved resolved by secondary row
        classified: {
          dependency: 3, // migratedDep (1) + remDep (1) + otherDep (1)
          recovery: 2,   // remRec (1) + dupResolved (1, updated from unknown by resolving row)
          unknown: 1,    // remUnk (1)
          human_decision: 1,
          external_wait: 0,
          resource: 0,
          terminal: 1,
        },
        unknown: 1,
        duplicate: 3, // 3 duplicate rows (dup-dep-key, dup-rec-key, dup-res-secondary)
        remainingAgeSeconds: 14400, // strictly selects max age among unmigrated remaining set (oldestRemainingDepId = 14400s), ignoring migrated items
      });

      const text = renderLegacyBlockedMetrics(sample, "api");
      for (const [metric, value] of [["migrated_total", 3], ["unknown_total", 1], ["duplicate_total", 3], ["remaining_age_seconds", 14400]]) {
        expect(text).toContain(`legacy_blocked_${metric}{role="api"} ${value}`);
      }
      expect(text).toContain('legacy_blocked_classified_total{role="api",class="dependency"} 3');
      expect(text).toContain('legacy_blocked_classified_total{role="api",class="recovery"} 2');
      expect(text).toContain('legacy_blocked_classified_total{role="api",class="unknown"} 1');
      expect(text).toContain('legacy_blocked_classified_total{role="api",class="human_decision"} 1');
      expect(text).toContain('legacy_blocked_classified_total{role="api",class="terminal"} 1');
    });
  });

  it("enforces migrated schema constraints and cascade behavior on foreign keys", async () => {
    const company = randomUUID();
    const issueId = randomUUID();
    const resultId = randomUUID();
    await db.insert(companies).values({ id: company, name: "Schema FK Test", issuePrefix: "SFK" });
    await db.insert(issues).values([
      { id: issueId, companyId: company, title: "Blocked issue", status: "blocked" },
      { id: resultId, companyId: company, title: "Resolution issue" },
    ]);

    await db.insert(legacyBlockedImports).values({
      companyId: company,
      importKey: "unique-key-1",
      issueId,
      class: "dependency",
      resultIssueId: resultId,
    });

    // 1. UNIQUE(company_id, import_key) enforcement
    await expect(
      db.insert(legacyBlockedImports).values({
        companyId: company,
        importKey: "unique-key-1",
        issueId,
        class: "recovery",
        resultIssueId: null,
      }),
    ).rejects.toThrow();

    // 2. FK to issues(company_id, id) ON DELETE CASCADE
    const [rowBefore] = await db.execute(sql`select count(*)::int as count from legacy_blocked_import where issue_id = ${issueId}`);
    expect(Number(rowBefore?.count)).toBe(1);

    // Deleting the referenced result_issue_id triggers ON DELETE SET NULL
    await db.execute(sql`delete from issues where id = ${resultId}`);
    const [rowAfterResultDelete] = await db.execute<{ result_issue_id: string | null }>(
      sql`select result_issue_id from legacy_blocked_import where issue_id = ${issueId}`,
    );
    expect(rowAfterResultDelete?.result_issue_id).toBeNull();

    // Deleting the source issue triggers ON DELETE CASCADE
    await db.execute(sql`delete from issues where id = ${issueId}`);
    const [rowAfterIssueDelete] = await db.execute(sql`select count(*)::int as count from legacy_blocked_import where issue_id = ${issueId}`);
    expect(Number(rowAfterIssueDelete?.count)).toBe(0);
  });
});
