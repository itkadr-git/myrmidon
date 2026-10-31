import { sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { legacyBlockedClassSchema, type LegacyBlockedReportRow } from "@myrmidon/shared";

/** L5 projection: identity is company + importKey, never an issue label. */
export interface LegacyBlockedJournalRow {
  companyId: string;
  report: Pick<LegacyBlockedReportRow, "issueId" | "importKey" | "class">;
  resultIssueId: string | null;
  createdAt: Date;
  /**
   * Original legacy blocked issue creation date (when available from issues table).
   * Used for measuring remaining age of the original blocked issue.
   */
  sourceCreatedAt?: Date | null;
}

export interface LegacyBlockedReadPort {
  readJournal(): Promise<readonly LegacyBlockedJournalRow[]>;
}

export interface LegacyBlockedMetrics {
  migrated: number;
  classified: Record<LegacyBlockedReportRow["class"], number>;
  unknown: number;
  duplicate: number;
  remainingAgeSeconds: number;
}

/** Read the actual L5 table without coupling this PR to its pending schema export. */
export function legacyBlockedReadPort(db: Db): LegacyBlockedReadPort {
  return {
    async readJournal() {
      if (!db || typeof (db as any).execute !== "function") {
        return [];
      }
      try {
        const existsResult = await db.execute<{ present: boolean }>(
          sql`select to_regclass('legacy_blocked_import') is not null as present`,
        );
        const existsRows = Array.isArray(existsResult)
          ? existsResult
          : ((existsResult as any)?.rows ?? []);
        // Before L5 is deployed there are no imports; do not break existing scrapes.
        if (!existsRows[0]?.present) return [];
      } catch {
        return [];
      }

      type RawLegacyBlockedRow = {
        company_id: string;
        import_key: string;
        issue_id: string;
        class: string;
        result_issue_id: string | null;
        created_at: Date | string;
        source_created_at: Date | string | null;
        [key: string]: unknown;
      };

      const rowsResult = await db.execute<RawLegacyBlockedRow>(sql`select
          l.company_id,
          l.import_key,
          l.issue_id,
          l.class,
          l.result_issue_id,
          l.created_at,
          i.created_at as source_created_at
        from legacy_blocked_import l
        left join issues i on i.id = l.issue_id and i.company_id = l.company_id
        order by l.created_at, l.company_id, l.import_key`);

      const rows: RawLegacyBlockedRow[] = Array.isArray(rowsResult)
        ? (rowsResult as RawLegacyBlockedRow[])
        : ((rowsResult as any)?.rows ?? []);

      return rows.map((row: RawLegacyBlockedRow) => {
        const classResult = legacyBlockedClassSchema.safeParse(row.class);
        return {
          companyId: row.company_id,
          report: {
            issueId: row.issue_id,
            importKey: row.import_key,
            class: classResult.success ? classResult.data : "unknown",
          },
          resultIssueId: row.result_issue_id,
          createdAt: new Date(row.created_at),
          sourceCreatedAt: row.source_created_at ? new Date(row.source_created_at) : null,
        };
      });
    },
  };
}

/** Counters are cumulative persisted L5 rows, not process-local scrape increments. */
export async function collectLegacyBlockedMetrics(
  port: LegacyBlockedReadPort,
  now: Date,
): Promise<LegacyBlockedMetrics> {
  const sample: LegacyBlockedMetrics = {
    migrated: 0,
    classified: { dependency: 0, recovery: 0, human_decision: 0, external_wait: 0, resource: 0, terminal: 0, unknown: 0 },
    unknown: 0,
    duplicate: 0,
    remainingAgeSeconds: 0,
  };

  const rows = await port.readJournal();
  const seenImportKeys = new Set<string>();

  // Group rows by issue key (companyId + issueId)
  interface IssueAgg {
    companyId: string;
    issueId: string;
    rows: LegacyBlockedJournalRow[];
  }
  const issuesMap = new Map<string, IssueAgg>();

  for (const row of rows) {
    const importKeyTag = JSON.stringify([row.companyId, row.report.importKey]);
    if (seenImportKeys.has(importKeyTag)) {
      sample.duplicate++;
      continue;
    }
    seenImportKeys.add(importKeyTag);

    const issueKey = JSON.stringify([row.companyId, row.report.issueId]);
    let agg = issuesMap.get(issueKey);
    if (!agg) {
      agg = { companyId: row.companyId, issueId: row.report.issueId, rows: [] };
      issuesMap.set(issueKey, agg);
    }
    agg.rows.push(row);
  }

  for (const agg of issuesMap.values()) {
    // If an issue was imported multiple times, subsequent entries count as duplicate
    if (agg.rows.length > 1) {
      sample.duplicate += (agg.rows.length - 1);
    }

    // Determine migration state: if ANY row resolved this issue (resultIssueId set or terminal class)
    const resolvingRow = agg.rows.find((r) => r.resultIssueId !== null || r.report.class === "terminal");
    const isMigrated = resolvingRow !== undefined && resolvingRow.report.class !== "unknown";

    // Effective classification: prefer resolving/non-unknown row, otherwise latest row
    const effectiveRow = resolvingRow ?? agg.rows[agg.rows.length - 1];
    sample.classified[effectiveRow.report.class]++;
    if (effectiveRow.report.class === "unknown") {
      sample.unknown++;
    }

    if (isMigrated) {
      sample.migrated++;
    } else {
      // Remaining unresolved issue: measure age from earliest sourceCreatedAt or createdAt
      const baseline = agg.rows[0].sourceCreatedAt ?? agg.rows[0].createdAt;
      const age = (now.getTime() - baseline.getTime()) / 1000;
      if (!Number.isFinite(age)) throw new Error("Invalid L5 journal timestamp");
      sample.remainingAgeSeconds = Math.max(sample.remainingAgeSeconds, age, 0);
    }
  }

  return sample;
}

export function renderLegacyBlockedMetrics(sample: LegacyBlockedMetrics | null, role: string): string {
  const escapedRole = role.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
  const labels = `role="${escapedRole}"`;
  const family = (name: string, help: string, type: string, values: string[]) =>
    [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...values].join("\n");
  const scalar = (name: string, help: string, value: number | undefined, type = "counter") =>
    family(name, help, type, value === undefined ? [] : [`${name}{${labels}} ${value}`]);
  return [
    scalar("legacy_blocked_migrated_total", "L5 imports with a result issue or terminal classification.", sample?.migrated),
    family("legacy_blocked_classified_total", "Unique L5 imports by classification, including unknown.", "counter",
      sample ? Object.entries(sample.classified).map(([name, value]) =>
        `legacy_blocked_classified_total{${labels},class="${name}"} ${value}`) : []),
    scalar("legacy_blocked_unknown_total", "Unique L5 imports classified as unknown.", sample?.unknown),
    scalar("legacy_blocked_duplicate_total", "Duplicate company/issue-id entries observed across journal imports.", sample?.duplicate),
    scalar("legacy_blocked_remaining_age_seconds", "Age of the oldest unresolved L5 import; zero when none remain.", sample?.remainingAgeSeconds, "gauge"),
  ].filter(Boolean).join("\n\n");
}
