// myrmidon(DBC-4): tests for the audit criteria and the markdown export.
//
// The criteria are the acceptance contract of the report, so each one is
// asserted twice where it matters: the verdict for a healthy value and the
// verdict for a value that must be called out. Two properties are checked
// separately because they are the easy ways to ship a lying report: a criterion
// without a previous snapshot must be `unknown` (never a silent `ok`), and the
// markdown must carry the measured value of every criterion plus the top-query
// table.
//
// Neutral data only: example.com, 192.0.2.0/24.

import { describe, expect, it } from "vitest";

import { BOARD_TARGET, prettyBytes } from "./domain.js";
import type { DatastoreCollectedSnapshot, DatastoreSnapshotPayload } from "./domain.js";
import {
  buildAuditReportMarkdown,
  evaluateCriteria,
  summarizeCriteria,
  topQueriesShare,
} from "./audit-report.js";

function payload(overrides: Partial<DatastoreCollectedSnapshot> = {}): DatastoreCollectedSnapshot {
  const base: DatastoreCollectedSnapshot = {
    key: "board",
    engine: "postgres",
    connectionRef: "board-primary",
    database: "board",
    dbId: 16384,
    serverVersion: "PostgreSQL 18.0 on x86_64-pc-linux-gnu",
    capturedAt: "2026-10-08T05:00:00.000Z",
    databaseBytes: 1_073_741_824,
    tablesBytes: 671_088_640,
    toastBytes: 50_000_000,
    indexBytes: 121_088_640,
    tables: [
      {
        table: "issues",
        totalBytes: 536_870_912,
        heapBytes: 400_000_000,
        toastBytes: 50_000_000,
        indexBytes: 86_870_912,
        liveRows: 1200,
        deadRows: 12,
      },
      {
        table: "activity_log",
        totalBytes: 134_217_728,
        heapBytes: 100_000_000,
        toastBytes: 0,
        indexBytes: 34_217_728,
        liveRows: 9000,
        deadRows: 90,
      },
    ],
    indexes: [
      { index: "issues_company_idx", table: "issues", bytes: 10_485_760, scans: 4200 },
      { index: "issues_legacy_idx", table: "issues", bytes: 5_242_880, scans: 0 },
    ],
    indexCount: 2,
    invalidIndexCount: 0,
    unusedIndexCount: 1,
    unusedIndexBytes: 5_242_880,
    largestUnusedIndex: "issues_legacy_idx",
    topQueries: [
      {
        queryId: "1234567",
        calls: 42,
        totalMs: 9000.5,
        meanMs: 214.286,
        rows: 9000,
        query: "SELECT * FROM issues WHERE company_id = $1",
      },
    ],
    topQueriesTotalMs: 12_000,
    statStatementsAvailable: true,
    settings: [
      { name: "autovacuum_analyze_scale_factor", value: "0.02", unit: null },
      { name: "autovacuum_vacuum_scale_factor", value: "0.01", unit: null },
      { name: "effective_cache_size", value: "2097152", unit: null },
      { name: "jit", value: "off", unit: null },
      { name: "shared_buffers", value: "524288", unit: null },
      { name: "wal_compression", value: "lz4", unit: null },
      { name: "work_mem", value: "4096", unit: null },
    ],
    extensions: [
      { name: "pg_stat_statements", version: "1.11" },
      { name: "plpgsql", version: "1.0" },
    ],
    databaseStats: {
      blksHit: 990_000,
      blksRead: 1000,
      xactCommit: 500,
      xactRollback: 1,
      backends: 7,
      maxConnections: 100,
      tempBytes: 2048,
    },
    backup: {
      available: true,
      dir: "/srv/backups/board",
      fileCount: 2,
      latestFile: "board-2026-10-08.dump",
      latestAt: "2026-10-08T02:00:00.000Z",
      ageHours: 3,
      bytes: 4096,
      note: null,
    },
    optional: { pgvector: null, fullTextSearch: null },
    warnings: [],
  };
  return { ...base, ...overrides };
}

function criterion(criteria: ReturnType<typeof evaluateCriteria>, id: string) {
  const found = criteria.find((entry) => entry.id === id);
  if (!found) throw new Error(`criterion ${id} is missing from the report`);
  return found;
}

describe("myrmidon(DBC-4) audit criteria", () => {
  it("evaluates the section-6 criteria and answers `ok` for a healthy board database", () => {
    const criteria = evaluateCriteria(payload());
    expect(criteria).toHaveLength(17);
    expect(new Set(criteria.map((entry) => entry.id)).size).toBe(17);

    expect(criterion(criteria, "db-size").verdict).toBe("ok");
    expect(criterion(criteria, "db-size").value).toBe(prettyBytes(1_073_741_824));
    expect(criterion(criteria, "cache-hit").verdict).toBe("ok");
    // 990_000 of 991_000 block reads served from the cache = 99.899 %.
    expect(criterion(criteria, "cache-hit").value).toBe("99.899 %");
    expect(criterion(criteria, "top-queries-share").verdict).toBe("ok");
    expect(criterion(criteria, "top-queries-share").value).toBe("75.0 %");
    expect(criterion(criteria, "stat-statements").verdict).toBe("ok");
    expect(criterion(criteria, "toast-share").verdict).toBe("ok");
    expect(criterion(criteria, "invalid-indexes").verdict).toBe("ok");
    expect(criterion(criteria, "dead-tuples").verdict).toBe("ok");
    expect(criterion(criteria, "autovacuum-vacuum").verdict).toBe("ok");
    expect(criterion(criteria, "autovacuum-analyze").verdict).toBe("ok");
    expect(criterion(criteria, "jit").verdict).toBe("ok");
    expect(criterion(criteria, "wal-compression").verdict).toBe("ok");
    expect(criterion(criteria, "work-mem").verdict).toBe("ok");
    expect(criterion(criteria, "effective-cache-size").verdict).toBe("ok");
    expect(criterion(criteria, "connections").verdict).toBe("ok");
    expect(criterion(criteria, "backup-freshness").verdict).toBe("ok");

    // The unused index of the sample is 1 of 2 = 50 %, above the 20 % rule.
    expect(criterion(criteria, "unused-indexes").verdict).toBe("warn");
    expect(criterion(criteria, "unused-indexes").value).toContain("1 из 2 (50.0 %)");

    const summary = summarizeCriteria(criteria, payload());
    // 15 ok, the unused index warns, and the sample carries no history for the
    // 24 h growth rule — that one is `unknown`, not `ok`.
    expect(summary).toMatchObject({ ok: 15, warn: 1, fail: 0, unknown: 1, worst: "warn" });
    expect(summary.databasePretty).toBe(prettyBytes(1_073_741_824));
    expect(summary.topQueries).toBe(1);
    expect(summary.statStatementsAvailable).toBe(true);
  });

  it("calls out the values that need an operator: broken index, stale backup, JIT, pglz", () => {
    const unhealthy = payload({
      databaseBytes: 9 * 1024 * 1024 * 1024,
      invalidIndexCount: 2,
      topQueriesTotalMs: 9500,
      tables: [
        {
          table: "issues",
          totalBytes: 100,
          heapBytes: 10,
          toastBytes: 95,
          indexBytes: 5,
          liveRows: 100,
          deadRows: 400,
        },
      ],
      indexCount: 10,
      unusedIndexCount: 1,
      unusedIndexBytes: 600 * 1024 * 1024,
      largestUnusedIndex: "a",
      indexes: [
        { index: "a", table: "issues", bytes: 600 * 1024 * 1024, scans: 0 },
        ...Array.from({ length: 9 }, (_, index) => ({
          index: `used_${index}`,
          table: "issues",
          bytes: 1024,
          scans: 10,
        })),
      ],
      databaseStats: {
        blksHit: 900_000,
        blksRead: 100_000,
        xactCommit: 5,
        xactRollback: 0,
        backends: 95,
        maxConnections: 100,
        tempBytes: 0,
      },
      settings: [
        { name: "autovacuum_vacuum_scale_factor", value: "0.2", unit: null },
        { name: "autovacuum_analyze_scale_factor", value: "0.2", unit: null },
        { name: "effective_cache_size", value: "524288", unit: null },
        { name: "jit", value: "on", unit: null },
        { name: "shared_buffers", value: "524288", unit: null },
        { name: "wal_compression", value: "pglz", unit: null },
        { name: "work_mem", value: "67108864", unit: null },
      ],
      backup: {
        available: true,
        dir: "/srv/backups/board",
        fileCount: 1,
        latestFile: "board-2026-10-06.dump",
        latestAt: "2026-10-06T02:00:00.000Z",
        ageHours: 51,
        bytes: 4096,
        note: null,
      },
    });

    const criteria = evaluateCriteria(unhealthy);
    expect(criterion(criteria, "db-size").verdict).toBe("warn");
    expect(criterion(criteria, "db-size").detail).toContain("8 ГиБ");
    expect(criterion(criteria, "invalid-indexes").verdict).toBe("fail");
    expect(criterion(criteria, "invalid-indexes").detail).toContain("REINDEX");
    expect(criterion(criteria, "backup-freshness").verdict).toBe("fail");
    expect(criterion(criteria, "cache-hit").verdict).toBe("warn");
    expect(criterion(criteria, "top-queries-share").verdict).toBe("warn");
    expect(criterion(criteria, "toast-share").verdict).toBe("warn");
    expect(criterion(criteria, "unused-indexes").verdict).toBe("warn");
    expect(criterion(criteria, "dead-tuples").verdict).toBe("warn");
    expect(criterion(criteria, "autovacuum-vacuum").verdict).toBe("warn");
    expect(criterion(criteria, "jit").verdict).toBe("warn");
    expect(criterion(criteria, "wal-compression").verdict).toBe("warn");
    expect(criterion(criteria, "work-mem").verdict).toBe("warn");
    expect(criterion(criteria, "effective-cache-size").verdict).toBe("warn");
    expect(criterion(criteria, "connections").verdict).toBe("warn");

    const summary = summarizeCriteria(criteria, unhealthy);
    expect(summary.worst).toBe("fail");
    // Two hard failures: the invalid index and the 51 h old backup.
    expect(summary.fail).toBe(2);
    // pg_stat_statements is present in the sample, so exactly one criterion is
    // still healthy.
    expect(summary.ok).toBe(1);
    expect(summary.unknown).toBe(1);
    expect(summary.warn).toBe(13);
  });

  it("fails the backup criterion when there is no backup at all", () => {
    const criteria = evaluateCriteria(
      payload({
        backup: {
          available: false,
          dir: "/srv/backups/board",
          fileCount: 0,
          latestFile: null,
          latestAt: null,
          ageHours: null,
          bytes: null,
          note: "ENOENT",
        },
      }),
    );
    expect(criterion(criteria, "backup-freshness").verdict).toBe("fail");
    expect(criterion(criteria, "backup-freshness").value).toContain("/srv/backups/board");
  });

  it("keeps the growth criterion `unknown` until there is a previous snapshot", () => {
    const alone = evaluateCriteria(payload());
    expect(criterion(alone, "growth-24h").verdict).toBe("unknown");
    expect(criterion(alone, "growth-24h").value).toBe("нет предыдущего снимка");

    const previous = payload({
      capturedAt: "2026-10-07T05:00:00.000Z",
      databaseBytes: 1_000_000_000,
    });
    const withPrevious = evaluateCriteria(
      payload({ capturedAt: "2026-10-08T05:00:00.000Z", databaseBytes: 1_010_000_000 }),
      previous,
    );
    const growth = criterion(withPrevious, "growth-24h");
    expect(growth.verdict).toBe("ok");
    expect(growth.value).toContain("+1.00 %");
    expect(growth.source).toContain("2026-10-07T05:00:00.000Z");

    // 10 % in a day is twice the 5 %/day rule: the criterion must call it out.
    const fast = evaluateCriteria(
      payload({ capturedAt: "2026-10-08T05:00:00.000Z", databaseBytes: 1_100_000_000 }),
      previous,
    );
    expect(criterion(fast, "growth-24h").verdict).toBe("warn");
  });

  it("reports the missing top queries instead of pretending they are healthy", () => {
    const criteria = evaluateCriteria(
      payload({ statStatementsAvailable: false, topQueries: [], topQueriesTotalMs: 0 }),
    );
    expect(criterion(criteria, "stat-statements").verdict).toBe("warn");
    expect(criterion(criteria, "stat-statements").detail).toContain("топ запросов");
    expect(criterion(criteria, "top-queries-share").verdict).toBe("unknown");
    expect(criterion(criteria, "top-queries-share").title).toContain("топ-0");
    expect(topQueriesShare(payload({ statStatementsAvailable: false }))).toBeNull();
  });

  it("adds the extension-gated criteria only when the extension is there", () => {
    const without = evaluateCriteria(payload());
    expect(without.map((entry) => entry.id)).not.toContain("pgvector-indexed");
    expect(without.map((entry) => entry.id)).not.toContain("full-text-search");

    const withExtensions = evaluateCriteria(
      payload({
        optional: {
          pgvector: {
            available: true,
            columns: [
              { table: "issue_embeddings", column: "embedding", indexed: true },
              { table: "issue_embeddings", column: "summary_vector", indexed: false },
            ],
          },
          fullTextSearch: { available: true, configurations: 2, tsvectorColumns: 1 },
        },
      }),
    );
    expect(withExtensions).toHaveLength(19);
    const pgvector = criterion(withExtensions, "pgvector-indexed");
    expect(pgvector.verdict).toBe("warn");
    expect(pgvector.value).toBe("1 из 2");
    expect(pgvector.detail).toContain("issue_embeddings.summary_vector");
    expect(criterion(withExtensions, "full-text-search").verdict).toBe("ok");
  });
});

describe("myrmidon(DBC-4) audit markdown", () => {
  it("carries every criterion with its measured value and the top queries", () => {
    const snapshot = payload();
    const criteria = evaluateCriteria(snapshot);
    const markdown = buildAuditReportMarkdown({
      target: BOARD_TARGET,
      generatedAt: "2026-10-08T05:00:01.000Z",
      trigger: "manual",
      snapshotId: "11111111-2222-3333-4444-555555555555",
      payload: snapshot,
      indexes: snapshot.indexes,
      criteria,
      summary: summarizeCriteria(criteria, snapshot),
    });

    expect(markdown).toContain("# Аудит базы доски — цель `board`");
    expect(markdown).toContain("- Сформирован: 2026-10-08T05:00:01.000Z (запрос: manual)");
    expect(markdown).toContain("11111111-2222-3333-4444-555555555555");
    expect(markdown).toContain("## Критерии (раздел 6)");
    // The id is the key the API and the gate read, so it is a column of its own
    // in the exported table.
    expect(markdown).toContain("| # | id | Критерий | Порог | Значение | Итог | Источник |");
    expect(markdown).toContain("| 1 | db-size |");
    expect(markdown).toContain("## Топ-1 запросов (pg_stat_statements)");
    expect(markdown).toContain("SELECT * FROM issues WHERE company_id = $1");
    expect(markdown).toContain("## Как проверить вручную");

    // Every criterion id, its value and its threshold reach the file — a
    // criterion the operator cannot see is a criterion that cannot be checked.
    for (const entry of criteria) {
      expect(markdown).toContain(entry.id);
      expect(markdown).toContain(entry.value.replace(/\|/g, "\\|"));
      expect(markdown).toContain(entry.threshold.replace(/\|/g, "\\|"));
    }

    // The manual-check section must name the psql reads behind the numbers.
    expect(markdown).toContain("pg_database_size");
    expect(markdown).toContain("pg_stat_statements");
    expect(markdown).toContain(prettyBytes(snapshot.toastBytes));
  });

  it("says a value is missing rather than printing an empty cell", () => {
    const snapshot = payload({
      dbId: null,
      serverVersion: "",
      backup: {
        available: false,
        dir: "/srv/backups/board",
        fileCount: 0,
        latestFile: null,
        latestAt: null,
        ageHours: null,
        bytes: null,
        note: "ENOENT",
      },
      warnings: ["table sizes: canceling statement due to statement timeout"],
    });
    const criteria = evaluateCriteria(snapshot);
    const markdown = buildAuditReportMarkdown({
      target: BOARD_TARGET,
      generatedAt: "2026-10-08T05:00:01.000Z",
      trigger: "hourly",
      snapshotId: null,
      payload: snapshot,
      indexes: snapshot.indexes,
      criteria,
      summary: summarizeCriteria(criteria, snapshot),
    });

    expect(markdown).toContain("dbid —");
    expect(markdown).toContain("## Предупреждения сбора");
    expect(markdown).toContain("canceling statement due to statement timeout");
    expect(markdown).toContain("нет бэкапа");
  });
});