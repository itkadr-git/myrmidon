import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import {
  issues,
  legacyBlockedImports,
  type Db,
} from "../../../packages/db/src/index.js";
import { buildRecoveryDedupeKey, type RecoveryFactoryKind, type RecoveryFactoryOwner } from "../../../packages/shared/src/recovery-factory.js";
import { issueRecoveryActionService } from "../../../server/src/services/issue-recovery-actions.js";
import {
  legacyBlockedClassSchema,
  legacyBlockedReportRowSchema,
  type LegacyBlockedReportRow,
} from "../../../packages/shared/src/legacy-blocked.js";
import { issueBlockReasonSchema } from "../../../packages/shared/src/validators/issue.js";
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

function recoveryKind(row: LegacyBlockedReportRow): RecoveryFactoryKind | undefined {
  // Only map explicitly identified recovery kinds; free-form prose cannot safely
  // select an operational recovery action.
  const match = row.evidence.match(/(?:kind|recovery kind)[:= ]+([a-z_]+)/i);
  const candidate = match?.[1];
  const supported: readonly string[] = [
    "ci_restart", "github_access", "branch_relay", "review_participant_restore",
    "workspace_myr_ws", "devbuild", "disk_space", "operator_action",
    "missing_disposition", "deliberate_wait_without_target", "stranded_assigned_issue",
    "workspace_validation", "configuration_validation", "active_run_watchdog", "issue_graph_liveness",
  ];
  return candidate && supported.includes(candidate) ? candidate as RecoveryFactoryKind : undefined;
}

function recoveryOwner(row: LegacyBlockedReportRow): RecoveryFactoryOwner | undefined {
  const value = row.proposedOwner;
  if (!value || value === "legacy-blocked-owner") return undefined;
  const agentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
  return agentId ? { agentId } : undefined;
}

function blockerMetadata(row: LegacyBlockedReportRow, source: { assigneeAgentId: string | null; assigneeUserId: string | null }) {
  const parsedClass = legacyBlockedClassSchema.safeParse(row.class);
  if (!parsedClass.success || parsedClass.data === "unknown" || parsedClass.data === "terminal" || parsedClass.data === "recovery") return undefined;
  const reason = issueBlockReasonSchema.safeParse(parsedClass.data);
  const owner = source.assigneeAgentId ? { agentId: source.assigneeAgentId } : source.assigneeUserId ? { userId: source.assigneeUserId } : undefined;
  // Never synthesize a blocker reference from the import key; that is not evidence
  // of a live dependency, external wait, or resource.
  if (!reason.success || !owner) return undefined;
  const next = new Date(Date.now() + 60 * 60_000);
  const metadata = {
    blockReason: reason.data,
    owner,
    nextCheckAt: next.toISOString(),
    timeoutAt: new Date(next.getTime() + 24 * 60 * 60_000).toISOString(),
    escalationPolicy: "notify_lead",
    externalRef: row.evidence,
  };
  return metadata.externalRef.trim().length > 0 ? metadata : undefined;
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
    if (row.class === "unknown" || row.class === "terminal") {
      rows.push({ issueId: row.issueId, class: row.class, outcome: "unknown", detail: `Retained blocked; classification=${row.class}; evidence=${row.evidence}` });
      continue;
    }
    if (!options.apply) {
      rows.push({ issueId: row.issueId, class: row.class, outcome: "dry_run", detail: `Would apply ${row.class}; evidence=${row.evidence}` });
      continue;
    }
    if (row.class === "recovery" && (!recoveryKind(row) || !recoveryOwner(row) || row.proposedSlaMinutes === undefined)) {
      rows.push({ issueId: row.issueId, class: row.class, outcome: "skipped", detail: "Recovery kind/owner/SLA are not explicitly present; retained blocked." });
      continue;
    }
    if (row.class !== "recovery" && !blockerMetadata(row, { assigneeAgentId: null, assigneeUserId: null })) {
      rows.push({ issueId: row.issueId, class: row.class, outcome: "skipped", detail: "No typed blocker reference and explicit owner are available; retained blocked." });
      continue;
    }
    const outcome = await db.transaction(async (tx) => {
      const [source] = await tx.select().from(issues).where(and(eq(issues.id, row.issueId), eq(issues.status, "blocked"))).for("update");
      if (!source) return { outcome: "skipped" as const, detail: "Source no longer blocked or missing." };
      const [journal] = await tx.select().from(legacyBlockedImports).where(and(
        eq(legacyBlockedImports.companyId, source.companyId),
        eq(legacyBlockedImports.importKey, row.importKey),
      ));
      if (journal?.resultIssueId) return { outcome: "already_applied" as const, detail: "Import journal already has a result.", resultIssueId: journal.resultIssueId };

      let resultIssueId: string | undefined;
      if (row.class === "recovery") {
        const kind = recoveryKind(row);
        const owner = recoveryOwner(row);
        if (!owner || !kind || row.proposedSlaMinutes === undefined) {
          return { outcome: "skipped" as const, detail: "Missing explicit recovery kind, valid owner, or SLA; retained blocked." };
        }
        const factory = issueRecoveryActionService(tx as unknown as Db);
        const result = await factory.ensureRecoveryIssue({
          kind,
          sourceIssueId: row.issueId,
          dedupeKey: buildRecoveryDedupeKey({ kind, scope: source.companyId, cause: row.importKey }),
          owner,
          slaMinutes: row.proposedSlaMinutes,
          nextCheckAt: new Date(Date.now() + row.proposedSlaMinutes * 60_000).toISOString(),
          evidence: { source: "legacy_blocked_import", importKey: row.importKey, classification: row.class, evidence: row.evidence },
        });
        resultIssueId = result.recoveryIssueId ?? undefined;
      } else {
        const metadata = blockerMetadata(row, source);
        if (!metadata) {
          return { outcome: "skipped" as const, detail: "No explicit owner or live blocker reference; retained blocked." };
        }
        const [updated] = await tx.update(issues).set({ blockerMetadata: metadata }).where(and(
          eq(issues.id, source.id), eq(issues.status, "blocked"), isNull(issues.blockerMetadata),
        )).returning({ id: issues.id });
        if (!updated) return { outcome: "skipped" as const, detail: "Source changed or already has blocker metadata." };
      }
      await tx.insert(legacyBlockedImports).values({
        companyId: source.companyId,
        importKey: row.importKey,
        issueId: source.id,
        class: row.class,
        resultIssueId: resultIssueId ?? null,
      }).onConflictDoNothing();
      return { outcome: "applied" as const, detail: `Applied ${row.class}.`, resultIssueId };
    });
    if (outcome.outcome === "applied") changed += 1;
    rows.push({ issueId: row.issueId, class: row.class, outcome: outcome.outcome, detail: outcome.detail, ...(outcome.resultIssueId ? { resultIssueId: outcome.resultIssueId } : {}) });
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
