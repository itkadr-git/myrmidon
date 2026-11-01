import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { agents } from "../../../packages/db/src/schema/agents.js";
import { issues, legacyBlockedImports, type Db } from "../../../packages/db/src/index.js";
import { buildRecoveryDedupeKey, type RecoveryFactoryKind } from "../../../packages/shared/src/recovery-factory.js";
import { issueRecoveryActionService } from "../../../server/src/services/issue-recovery-actions.js";
import { legacyBlockedReportRowSchema, type LegacyBlockedReportRow } from "../../../packages/shared/src/legacy-blocked.js";
import { runLegacyBlockedDryRun } from "./dry-run.js";

export type LegacyBlockedApplyOptions = { apply?: boolean };
export type LegacyBlockedApplyRow = {
  issueId: string;
  class: string;
  outcome: "dry_run" | "applied" | "unknown" | "already_applied" | "skipped";
  detail: string;
  resultIssueId?: string;
};
export type LegacyBlockedApplyResult = { rows: LegacyBlockedApplyRow[]; changed: number };

function recoveryKindForEvidence(row: LegacyBlockedReportRow): RecoveryFactoryKind | undefined {
  if (row.class === "recovery" && /(?:missing disposition|recovery task is required|recovery issue is required|operator action is required)/i.test(row.evidence)) return "missing_disposition";
  return undefined;
}

function recoveryOwnerForRow(row: LegacyBlockedReportRow): { agentId: string } | undefined {
  const owner = row.proposedOwner;
  if (!owner || owner === "legacy-blocked-owner") return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(owner)) {
    return { agentId: owner };
  }
  return undefined;
}

function blockerMetadata(row: LegacyBlockedReportRow, source: { assigneeAgentId: string | null; assigneeUserId: string | null }) {
  if (row.class !== "dependency" || row.oldBlockers.length === 0) return undefined;
  const owner = source.assigneeAgentId ? { agentId: source.assigneeAgentId } : source.assigneeUserId ? { userId: source.assigneeUserId } : undefined;
  if (!owner) return undefined;
  const next = new Date(Date.now() + 60 * 60_000);
  return {
    blockReason: "dependency" as const,
    owner,
    nextCheckAt: next.toISOString(),
    timeoutAt: new Date(next.getTime() + 24 * 60 * 60_000).toISOString(),
    escalationPolicy: "notify_lead" as const,
    blockedByIssueIds: row.oldBlockers,
  };
}

/**
 * Apply one dry-run report within a DB transaction. Defaults to read-only;
 * unknown and untyped records are retained as blocked and annotated in journal.
 */
export async function runLegacyBlockedApply(db: Db, options: LegacyBlockedApplyOptions = {}): Promise<LegacyBlockedApplyResult> {
  const dryRun = await runLegacyBlockedDryRun(db);
  const rows: LegacyBlockedApplyRow[] = [];
  let changed = 0;
  for (const row of dryRun.report.rows) {
    const parsedReportRow = legacyBlockedReportRowSchema.safeParse(row);
    if (!parsedReportRow.success) {
      rows.push({ issueId: row.issueId, class: String(row.class), outcome: "skipped", detail: "Invalid classification report row; retained blocked." });
      continue;
    }
    const validRow = parsedReportRow.data;
    if (validRow.class === "unknown") {
      rows.push({ issueId: validRow.issueId, class: validRow.class, outcome: "unknown", detail: `Retained blocked; classification=unknown; evidence=${validRow.evidence}` });
      continue;
    }
    if (validRow.class === "terminal") {
      rows.push({ issueId: validRow.issueId, class: validRow.class, outcome: "skipped", detail: `Terminal class is not migrated; retained blocked; evidence=${validRow.evidence}` });
      continue;
    }
    if (!options.apply) {
      rows.push({ issueId: validRow.issueId, class: validRow.class, outcome: "dry_run", detail: `Would apply ${validRow.class}; evidence=${validRow.evidence}` });
      continue;
    }
    const outcome = await db.transaction(async (tx) => {
      const [lockedSource] = await tx.select().from(issues).where(and(eq(issues.id, validRow.issueId), eq(issues.status, "blocked"), isNull(issues.blockerMetadata))).for("update");
      if (!lockedSource) return { outcome: "skipped" as const, detail: "Source is missing, no longer blocked, or already has metadata." };
      const source = lockedSource;
      const [journal] = await tx.select().from(legacyBlockedImports).where(and(
        eq(legacyBlockedImports.companyId, source.companyId), eq(legacyBlockedImports.importKey, validRow.importKey),
      ));
      if (journal) {
        return journal.resultIssueId
          ? { outcome: "already_applied" as const, detail: "Import journal already has a result.", resultIssueId: journal.resultIssueId }
          : { outcome: "skipped" as const, detail: "Journal indicates a partial prior apply; retained for reconciliation." };
      }
      if (validRow.class === "dependency") {
        if (validRow.oldBlockers.length === 0) return { outcome: "skipped" as const, detail: "No explicit old blockers; retained blocked." };
        const [liveBlocker] = await tx.select({ id: issues.id }).from(issues).where(and(
          inArray(issues.id, validRow.oldBlockers), eq(issues.companyId, source.companyId),
          inArray(issues.status, ["blocked", "in_progress", "in_review", "todo"]),
        ));
        if (!liveBlocker) return { outcome: "skipped" as const, detail: "No explicit old blocker is still active; retained blocked." };
      }

      let resultIssueId: string | undefined;
      if (validRow.class === "recovery") {
        const recoveryKind = recoveryKindForEvidence(validRow);
        const recoveryOwner = recoveryOwnerForRow(validRow);
        const slaMinutes = validRow.proposedSlaMinutes;
        if (!recoveryKind || !recoveryOwner || slaMinutes === undefined) {
          return { outcome: "skipped" as const, detail: "Missing explicit kind, valid assigned agent, or SLA; retained blocked." };
        }
        const [validOwner] = await tx.select({ id: agents.id }).from(agents).where(and(
          eq(agents.id, recoveryOwner.agentId), eq(agents.companyId, source.companyId),
        ));
        if (!validOwner) return { outcome: "skipped" as const, detail: "Recovery owner is not in source company; retained blocked." };
        const result = await issueRecoveryActionService(tx).ensureRecoveryIssue({
          kind: recoveryKind,
          sourceIssueId: source.id,
          dedupeKey: buildRecoveryDedupeKey({ kind: recoveryKind, scope: source.companyId, cause: validRow.importKey }),
          owner: recoveryOwner,
          slaMinutes,
          nextCheckAt: new Date(Date.now() + slaMinutes * 60_000).toISOString(),
          runbookRef: `legacy-blocked:${validRow.importKey}`,
          evidence: { source: "legacy_blocked_import", importKey: validRow.importKey, classification: validRow.class, evidence: validRow.evidence },
        });
        if (!result.recoveryIssueId) return { outcome: "skipped" as const, detail: "Recovery factory returned no issue; source retained blocked." };
        resultIssueId = result.recoveryIssueId;
      } else {
        const metadata = blockerMetadata(validRow, source);
        if (!metadata) return { outcome: "skipped" as const, detail: "No explicit owner or live blocker reference; retained blocked." };
        const [updated] = await tx.update(issues).set({ blockerMetadata: metadata }).where(and(
          eq(issues.id, source.id), eq(issues.status, "blocked"), isNull(issues.blockerMetadata),
        )).returning({ id: issues.id });
        if (!updated) return { outcome: "skipped" as const, detail: "Source changed before metadata could be applied." };
      }

      await tx.insert(legacyBlockedImports).values({
        companyId: source.companyId,
        importKey: validRow.importKey,
        issueId: source.id,
        class: validRow.class,
        resultIssueId: resultIssueId ?? null,
      });
      return { outcome: "applied" as const, detail: `Applied ${validRow.class}.`, resultIssueId };
    });
    if (outcome.outcome === "applied") changed += 1;
    rows.push({ issueId: validRow.issueId, class: validRow.class, outcome: outcome.outcome, detail: outcome.detail, ...(outcome.resultIssueId ? { resultIssueId: outcome.resultIssueId } : {}) });
  }
  return { rows, changed };
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (direct) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL environment variable is required."); process.exit(1); }
  if (apply && process.env.LEGACY_BLOCKED_APPLY_CONFIRM !== "yes") {
    console.error("Apply requires LEGACY_BLOCKED_APPLY_CONFIRM=yes; --dry-run is the default."); process.exit(2);
  }
  const { createDb, closeRegisteredClients } = await import("@myrmidon/db");
  const db = createDb(dbUrl);
  try {
    const result = await runLegacyBlockedApply(db, { apply });
    for (const row of result.rows) console.log(JSON.stringify(row));
    console.log(JSON.stringify({ changed: result.changed, mode: apply ? "apply" : "dry-run" }));
  } catch (error) {
    console.error("Legacy blocked apply failed:", error);
    process.exitCode = 1;
  } finally { await closeRegisteredClients(dbUrl); }
}
