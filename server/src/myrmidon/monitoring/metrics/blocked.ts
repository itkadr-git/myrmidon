import type { IssueBlockerMetadata } from "@myrmidon/shared";

/** Structural port shared with loadBlockedGraph (OPE-9162). */
export interface BlockedMetricsIssue {
  id: string;
  status: string;
  blockerMetadata: Partial<IssueBlockerMetadata> | null;
  blockedSince: Date | null;
}

export type BlockedGraphMetricsPort = (companyId: string) => Promise<{
  blockedIssues: readonly BlockedMetricsIssue[];
}>;

export interface BlockedMetricsGroup {
  legacy: boolean;
  count: number;
  ageSeconds: { p50: number | null; p95: number | null; max: number | null };
  missingFields: { reason: number; owner: number; nextCheckAt: number };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Current-state gauges, not cumulative counters; null metadata denotes legacy. */
export function computeBlockedMetrics(
  blockedIssues: readonly BlockedMetricsIssue[],
  now: Date,
): BlockedMetricsGroup[] {
  const groups: BlockedMetricsGroup[] = [];
  for (const legacy of [false, true]) {
    const rows = blockedIssues.filter((row) => row.status === "blocked"
      && (row.blockerMetadata == null) === legacy);
    const ages: number[] = [];
    const missingFields = { reason: 0, owner: 0, nextCheckAt: 0 };
    for (const row of rows) {
      const metadata = row.blockerMetadata;
      if (!nonEmpty(metadata?.blockReason)) missingFields.reason++;
      const owner = metadata?.owner;
      if (!owner || !("agentId" in owner && nonEmpty(owner.agentId))
        && !("userId" in owner && nonEmpty(owner.userId))) missingFields.owner++;
      if (!nonEmpty(metadata?.nextCheckAt)) missingFields.nextCheckAt++;
      // Unknown transition timestamps must not masquerade as zero-age samples.
      const since = row.blockedSince?.getTime();
      if (since !== undefined && Number.isFinite(since)) {
        ages.push(Math.max(0, (now.getTime() - since) / 1000));
      }
    }
    ages.sort((a, b) => a - b);
    const percentile = (quantile: number) => ages.length === 0
      ? null : ages[Math.ceil(quantile * ages.length) - 1]!;
    groups.push({
      legacy,
      count: rows.length,
      ageSeconds: { p50: percentile(0.5), p95: percentile(0.95), max: ages.at(-1) ?? null },
      missingFields,
    });
  }
  return groups;
}

export async function collectBlockedMetrics(
  loadGraph: BlockedGraphMetricsPort,
  companyId: string,
  now = new Date(),
): Promise<BlockedMetricsGroup[]> {
  return computeBlockedMetrics((await loadGraph(companyId)).blockedIssues, now);
}

/** Standalone exposition seam; registration belongs to the shared collector owner. */
export function renderBlockedMetrics(groups: readonly BlockedMetricsGroup[]): string {
  const lines = [
    "# HELP blocked_age_seconds Current blocked age in seconds (nearest-rank percentiles).",
    "# TYPE blocked_age_seconds gauge",
  ];
  for (const group of groups) {
    for (const statistic of ["p50", "p95", "max"] as const) {
      const value = group.ageSeconds[statistic];
      if (value !== null) {
        lines.push(`blocked_age_seconds{legacy="${group.legacy}",statistic="${statistic}"} ${value}`);
      }
    }
  }
  lines.push(
    "# HELP blocked_missing_fields_total Current blocked issues missing each required field.",
    "# TYPE blocked_missing_fields_total gauge",
  );
  for (const group of groups) {
    for (const field of ["reason", "owner", "nextCheckAt"] as const) {
      lines.push(`blocked_missing_fields_total{legacy="${group.legacy}",field="${field}"} ${group.missingFields[field]}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
