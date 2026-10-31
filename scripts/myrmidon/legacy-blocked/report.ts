import { createLegacyBlockedImportKey, legacyBlockedClassSchema, legacyBlockedReportRowSchema, type LegacyBlockedReportRow } from "../../../packages/shared/src/legacy-blocked.ts";

export type ReconciliationInventoryEntry = {
  id: string;
  identifier: string;
  status: string;
  blockerMetadata?: unknown;
};

export type ReconciliationResult = {
  issueId: string;
  class: string;
  evidence?: readonly string[];
  proposedOwner?: string;
  proposedSlaMinutes?: number;
  importKey?: string;
};

export type ReconciliationDuplicate = { importKey: string; issueIds: string[] };
export type ReconciliationLost = {
  issueId: string;
  identifier?: string;
  reason: "missing_result" | "missing_inventory" | "duplicate_result" | "duplicate_inventory" | "invalid_result";
};
export type ReconciliationReport = {
  rows: LegacyBlockedReportRow[];
  totals: Record<LegacyBlockedReportRow["class"], number>;
  unknown: LegacyBlockedReportRow[];
  duplicates: ReconciliationDuplicate[];
  lost: ReconciliationLost[];
  markdown: string;
  json: string;
};

const classes = ["dependency", "recovery", "human_decision", "external_wait", "resource", "terminal", "unknown"] as const;

function escapeMarkdown(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function toReportRow(
  inventory: ReconciliationInventoryEntry,
  result: ReconciliationResult,
): LegacyBlockedReportRow | undefined {
  const blockClass = legacyBlockedClassSchema.safeParse(result.class);
  if (!blockClass.success) return undefined;
  const proposedKey = typeof result.importKey === "string" ? result.importKey.trim() : "";
  const parsed = legacyBlockedReportRowSchema.safeParse({
    issueId: inventory.id,
    identifier: inventory.identifier,
    oldStatus: inventory.status,
    oldBlockers: Array.isArray(inventory.blockerMetadata) ? inventory.blockerMetadata.map(String) : [],
    class: blockClass.data,
    proposedOwner: result.proposedOwner,
    proposedSlaMinutes: result.proposedSlaMinutes,
    evidence: (result.evidence ?? []).map((item) => item.trim()).filter(Boolean).join("; ") || "No classification evidence provided.",
    importKey: proposedKey || createLegacyBlockedImportKey(inventory.id),
  });
  return parsed.success ? parsed.data : undefined;
}

function renderMarkdown(
  rows: readonly LegacyBlockedReportRow[],
  totals: ReconciliationReport["totals"],
  duplicates: readonly ReconciliationDuplicate[],
  lost: readonly ReconciliationLost[],
): string {
  return [
    "# Legacy blocked reconciliation report",
    "",
    "## Totals",
    "",
    "| Class | Count |",
    "| --- | ---: |",
    ...classes.map((blockClass) => `| ${blockClass} | ${totals[blockClass]} |`),
    `| **Total** | **${rows.length}** |`,
    "",
    "## Rows",
    "",
    "| Identifier | Old status | Class | Owner | SLA (minutes) | Import key | Evidence |",
    "| --- | --- | --- | --- | ---: | --- | --- |",
    ...rows.map((row) => `| ${escapeMarkdown(row.identifier)} | ${escapeMarkdown(row.oldStatus)} | ${row.class} | ${escapeMarkdown(row.proposedOwner ?? "")} | ${row.proposedSlaMinutes ?? ""} | ${escapeMarkdown(row.importKey)} | ${escapeMarkdown(row.evidence)} |`),
    "",
    "## Duplicates",
    "",
    ...(duplicates.length ? duplicates.map((entry) => `- ${escapeMarkdown(entry.importKey)}: ${entry.issueIds.map(escapeMarkdown).join(", ")}`) : ["None."]),
    "",
    "## Lost",
    "",
    ...(lost.length ? lost.map((entry) => `- ${escapeMarkdown(entry.issueId)}${entry.identifier ? ` (${escapeMarkdown(entry.identifier)})` : ""}: ${entry.reason}`) : ["None."]),
    "",
  ].join("\n");
}

export function buildReconciliationReport(
  inventory: readonly ReconciliationInventoryEntry[],
  results: readonly ReconciliationResult[],
): ReconciliationReport {
  const inventoryById = new Map<string, ReconciliationInventoryEntry[]>();
  const resultsById = new Map<string, ReconciliationResult[]>();
  const lost: ReconciliationLost[] = [];
  const rows: LegacyBlockedReportRow[] = [];

  for (const entry of inventory) {
    const group = inventoryById.get(entry.id) ?? [];
    group.push(entry);
    inventoryById.set(entry.id, group);
  }
  for (const result of results) {
    const group = resultsById.get(result.issueId) ?? [];
    group.push(result);
    resultsById.set(result.issueId, group);
    if (!inventoryById.has(result.issueId)) lost.push({ issueId: result.issueId, reason: "missing_inventory" });
  }

  for (const [issueId, entries] of inventoryById) {
    if (entries.length > 1) {
      for (const entry of entries) {
        lost.push({ issueId, identifier: entry.identifier, reason: "duplicate_inventory" });
      }
      continue;
    }
    const matches = resultsById.get(issueId) ?? [];
    if (matches.length === 0) {
      lost.push({ issueId, identifier: entries[0].identifier, reason: "missing_result" });
      continue;
    }
    if (matches.length > 1) {
      lost.push({ issueId, identifier: entries[0].identifier, reason: "duplicate_result" });
      continue;
    }
    const row = toReportRow(entries[0], matches[0]);
    if (!row) {
      lost.push({ issueId, identifier: entries[0].identifier, reason: "invalid_result" });
      continue;
    }
    rows.push(row);
  }

  const rowsByKey = new Map<string, string[]>();
  for (const row of rows) {
    const group = rowsByKey.get(row.importKey) ?? [];
    group.push(row.issueId);
    rowsByKey.set(row.importKey, group);
  }
  const duplicates = [...rowsByKey]
    .filter(([, issueIds]) => issueIds.length > 1)
    .map(([importKey, issueIds]) => ({ importKey, issueIds }));
  const totals = Object.fromEntries(classes.map((blockClass) => [blockClass, rows.filter((row) => row.class === blockClass).length])) as ReconciliationReport["totals"];
  const unknown = rows.filter((row) => row.class === "unknown");
  const data = { rows, totals, unknown, duplicates, lost };
  const totalsSum = Object.values(totals).reduce((sum, value) => sum + value, 0);
  if (totalsSum !== rows.length) {
    throw new Error("Reconciliation class totals do not match emitted rows.");
  }
  const uniqueLostInventoryIds = new Set(
    lost.filter((entry) => inventoryById.has(entry.issueId)).map((entry) => entry.issueId),
  );
  if (totalsSum + uniqueLostInventoryIds.size !== inventoryById.size) {
    throw new Error("Reconciliation invariant violated: sum(totals) + unique lost inventory != inventory count.");
  }
  return {
    ...data,
    markdown: renderMarkdown(rows, totals, duplicates, lost),
    json: JSON.stringify(data, null, 2),
  };
}
