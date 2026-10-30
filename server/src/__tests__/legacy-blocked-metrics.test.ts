import { describe, expect, it } from "vitest";
import { collectLegacyBlockedMetrics, renderLegacyBlockedMetrics, type LegacyBlockedJournalRow } from "../myrmidon/monitoring/metrics/legacy-blocked.js";

const now = new Date("2026-10-27T12:00:00Z");
function row(key: string, cls: LegacyBlockedJournalRow["report"]["class"], result: string | null, age: number): LegacyBlockedJournalRow {
  return { companyId: "company-a", report: { issueId: key, importKey: key, class: cls }, resultIssueId: result, createdAt: new Date(now.getTime() - age * 1000) };
}

describe("legacy blocked metrics projection", () => {
  it("classifies unique imports, counts duplicates only within a company, and ages unresolved rows", async () => {
    const rows = [row("a", "dependency", "result", 300), row("b", "unknown", null, 120), row("c", "terminal", null, 250), row("d", "resource", null, 60)];
    rows.push(rows[0], { ...rows[0], companyId: "company-b" });
    const port = { readJournal: async () => rows };
    const sample = await collectLegacyBlockedMetrics(port, now);
    expect(sample).toEqual({ migrated: 3, classified: { dependency: 2, recovery: 0, human_decision: 0, external_wait: 0, resource: 1, terminal: 1, unknown: 1 }, unknown: 1, duplicate: 1, remainingAgeSeconds: 120 });
    expect(await collectLegacyBlockedMetrics(port, now)).toEqual(sample);
    const rendered = renderLegacyBlockedMetrics(sample, "worker");
    expect(rendered).toContain('legacy_blocked_classified_total{role="worker",class="unknown"} 1');
    expect(rendered).toContain('legacy_blocked_remaining_age_seconds{role="worker"} 120');
    expect(rendered).not.toContain("company-a");
    expect(rendered.match(/^# TYPE /gm)).toHaveLength(5);
  });

  it("prefers sourceCreatedAt for remaining age and updates migration status when secondary duplicate row resolves the issue", async () => {
    const originalCreated = new Date(now.getTime() - 7200 * 1000);
    const journalCreated = new Date(now.getTime() - 600 * 1000);
    const rows: LegacyBlockedJournalRow[] = [
      {
        companyId: "company-a",
        report: { issueId: "issue-1", importKey: "import-1", class: "unknown" },
        resultIssueId: null,
        createdAt: journalCreated,
        sourceCreatedAt: originalCreated,
      },
      // Second row with same issueId but different importKey is counted as duplicate,
      // and its result updates the migration state.
      {
        companyId: "company-a",
        report: { issueId: "issue-1", importKey: "import-alt", class: "dependency" },
        resultIssueId: "res-1",
        createdAt: journalCreated,
        sourceCreatedAt: originalCreated,
      },
      // Third issue is unresolved and remaining.
      {
        companyId: "company-a",
        report: { issueId: "issue-2", importKey: "import-2", class: "recovery" },
        resultIssueId: null,
        createdAt: journalCreated,
        sourceCreatedAt: new Date(now.getTime() - 3600 * 1000),
      },
    ];
    const port = {
      readJournal: async () => rows,
    };
    const sample = await collectLegacyBlockedMetrics(port, now);
    expect(sample.remainingAgeSeconds).toBe(3600);
    expect(sample.duplicate).toBe(1); // 1 duplicate issue row
    expect(sample.migrated).toBe(1); // issue-1 resolved by secondary row
    expect(sample.classified.dependency).toBe(1);
    expect(sample.classified.recovery).toBe(1);
    expect(sample.unknown).toBe(0);
  });

  it("returns zero for an empty journal and clamps future ages", async () => {
    expect((await collectLegacyBlockedMetrics({ readJournal: async () => [] }, now)).remainingAgeSeconds).toBe(0);
    expect((await collectLegacyBlockedMetrics({ readJournal: async () => [row("future", "unknown", null, -10)] }, now)).remainingAgeSeconds).toBe(0);
  });

  it("does not fabricate successful zero samples on read failure", async () => {
    await expect(collectLegacyBlockedMetrics({ readJournal: async () => { throw new Error("L5 unavailable"); } }, now)).rejects.toThrow("L5 unavailable");
    expect(renderLegacyBlockedMetrics(null, "api")).not.toMatch(/^legacy_blocked_/m);
  });
});
