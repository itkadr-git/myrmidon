import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desc, eq, inArray, or } from "drizzle-orm";
import { issueComments, issueRelations, issues } from "../../../packages/db/src/index.js";
import { createLegacyBlockedImportKey } from "../../../packages/shared/src/legacy-blocked.js";
import { listLegacyBlocked } from "./inventory.js";
import {
  classifyLegacyBlocked,
  type LegacyBlockedFacts,
  type LegacyBlockedLinkFact,
} from "./classify.js";
import {
  buildReconciliationReport,
  type ReconciliationInventoryEntry,
  type ReconciliationReport,
  type ReconciliationResult,
} from "./report.js";

const resolvedBlockerStatuses = new Set(["done", "cancelled"]);

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[ -]+/g, "_") ?? "";
}

export type DryRunOptions = {
  outputFile?: string;
  format?: "json" | "markdown";
};

export type DryRunResult = {
  report: ReconciliationReport;
  outputFilePath: string;
  content: string;
};

type InventoriedIssue = {
  id: string;
  identifier?: string;
  status: string;
  title?: string;
  description?: string;
  blockerMetadata?: unknown;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  responsibleUserId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  companyId?: string;
  [key: string]: unknown;
};

/**
 * Extracts classification facts for a single legacy-blocked issue in a strictly read-only manner.
 */
async function extractIssueFacts(
  db: any,
  issue: InventoriedIssue,
): Promise<LegacyBlockedFacts> {
  const comments = await db
    .select({ body: issueComments.body })
    .from(issueComments)
    .where(eq(issueComments.issueId, issue.id))
    .orderBy(desc(issueComments.createdAt));

  const relations = await db
    .select({
      issueId: issueRelations.issueId,
      relatedIssueId: issueRelations.relatedIssueId,
      type: issueRelations.type,
    })
    .from(issueRelations)
    .where(or(eq(issueRelations.relatedIssueId, issue.id), eq(issueRelations.issueId, issue.id)));

  const blockerIds = relations
    .filter((r: { issueId: string; relatedIssueId: string; type: string }) => r.type === "blocks" && r.relatedIssueId === issue.id)
    .map((r: { issueId: string }) => r.issueId)
    .filter((id, index, ids) => ids.indexOf(id) === index);
  let blockerIssues: Array<{ id: string; status: string; identifier: string | null }> = [];
  if (blockerIds.length > 0) {
    blockerIssues = await db
      .select({
        id: issues.id,
        status: issues.status,
        identifier: issues.identifier,
      })
      .from(issues)
      .where(inArray(issues.id, blockerIds));
  }

  const blockerMap = new Map(blockerIssues.map((b) => [b.id, b]));
  const links: LegacyBlockedLinkFact[] = relations.map((r: { issueId: string; relatedIssueId: string; type: string }) => {
    const blockerIssueId = r.relatedIssueId === issue.id ? r.issueId : r.relatedIssueId;
    const blocker = blockerMap.get(blockerIssueId);
    return {
      type: "issue" as const,
      relation: r.type,
      status: blocker?.status ?? "unknown",
      label: blocker?.identifier ?? blocker?.id ?? blockerIssueId,
    };
  });

  const activeBlockerIds = blockerIssues
    .filter((blocker) => !resolvedBlockerStatuses.has(normalized(blocker.status)))
    .map((blocker) => blocker.id);

  return {
    taskStatus: issue.status,
    latestComments: [
      ...(typeof issue.description === "string" && issue.description.trim() ? [issue.description.trim()] : []),
      ...comments
        .map((c: { body: unknown }) => (typeof c.body === "string" ? c.body : ""))
        .filter((b: string) => b.length > 0),
    ],
    links,
    blockerIds: activeBlockerIds,
  };
}

/**
 * Executes a strictly read-only dry run over legacy-blocked issues:
 * 1. Inventory (L2): lists eligible legacy-blocked issues from DB.
 * 2. Classify (L3): extracts facts from read-only tables and classifies evidence.
 * 3. Report (L4): generates reconciliation report without loss.
 * 4. Outputs report to a designated file.
 *
 * Database modification is prohibited.
 */
export async function runLegacyBlockedDryRun(
  db: any,
  options?: DryRunOptions,
): Promise<DryRunResult> {
  const rawInventory = await listLegacyBlocked(db);
  const inventory = (Array.isArray(rawInventory) ? rawInventory : []) as InventoriedIssue[];

  const results: ReconciliationResult[] = [];
  const inventoryEntries: ReconciliationInventoryEntry[] = [];

  for (const issue of inventory) {
    inventoryEntries.push({
      id: issue.id,
      identifier: issue.identifier ?? issue.id,
      status: issue.status,
      blockerMetadata: issue.blockerMetadata,
    });

    const facts = await extractIssueFacts(db, issue);
    const classification = classifyLegacyBlocked(facts);

    const proposedOwner =
      (typeof issue.assigneeAgentId === "string" && issue.assigneeAgentId.trim()) ||
      (typeof issue.assigneeUserId === "string" && issue.assigneeUserId.trim());

    const proposedSlaMinutes = classification.class === "recovery" && proposedOwner ? 60 : undefined;

    results.push({
      issueId: issue.id,
      class: classification.class,
      evidence: classification.evidence,
      proposedOwner: classification.class === "unknown" ? undefined : proposedOwner,
      proposedSlaMinutes,
      oldBlockers: facts.blockerIds ?? [],
      importKey: createLegacyBlockedImportKey(issue.id),
    });
  }

  const report = buildReconciliationReport(inventoryEntries, results);
  const format = options?.format ?? "json";
  const content = format === "markdown" ? report.markdown : report.json;

  const defaultFileName = `legacy-blocked-dry-run-report.${format === "markdown" ? "md" : "json"}`;
  const outputFilePath = options?.outputFile
    ? path.resolve(options.outputFile)
    : path.resolve(process.cwd(), defaultFileName);

  await fs.mkdir(path.dirname(outputFilePath), { recursive: true });
  await fs.writeFile(outputFilePath, content, "utf-8");

  return {
    report,
    outputFilePath,
    content,
  };
}

// CLI entrypoint
const isDirectExecution =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  const args = process.argv.slice(2);
  let outputFile: string | undefined;
  let format: "json" | "markdown" = "json";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) {
      outputFile = args[++i];
    } else if (args[i] === "--format" && (args[i + 1] === "json" || args[i + 1] === "markdown")) {
      format = args[++i] as "json" | "markdown";
    }
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  const { createDb, closeRegisteredClients } = await import("@myrmidon/db");
  const db = createDb(databaseUrl);

  try {
    const result = await runLegacyBlockedDryRun(db, { outputFile, format });
    console.log(`Dry-run report generated at: ${result.outputFilePath}`);
    console.log(`Totals: ${JSON.stringify(result.report.totals)}`);
  } catch (error) {
    console.error("Failed to execute legacy-blocked dry-run:", error);
    process.exit(1);
  } finally {
    await closeRegisteredClients(databaseUrl);
  }
}
