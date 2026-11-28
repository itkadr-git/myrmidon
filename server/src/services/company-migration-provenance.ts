import type { Db } from "@myrmidon/db";
import {
  activityLog, agents, assets, companies, companyLogos, companyMemberships, companySecretBindings,
  companySkills, documentRevisions, documents, folders, issueAttachments, issueComments, issueDocuments,
  issueInboxArchives, issueLabels, issueRelations, issues, issueWorkProducts, labels, principalPermissionGrants,
  projects, projectWorkspaces, routineRevisions, routines, routineTriggers, userSecretDeclarations,
} from "@myrmidon/db";
import { eq, getTableName, is, sql } from "drizzle-orm";
import * as schema from "@myrmidon/db";
import { PgTable, type AnyPgColumn } from "drizzle-orm/pg-core";
import { migrationCompanyFingerprint, migrationRowFingerprint } from "./company-transfer-runs.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Entry = Record<string, unknown>;

function record(value: unknown): Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid migration provenance");
  return value as Entry;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid migration fingerprint");
  return value;
}

function rows(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid migration provenance rows");
  return value.map((entry) => fingerprint(record(entry).fingerprint));
}

function section(value: unknown): Entry[] {
  return value === undefined ? [] : Object.values(record(value)).map(record);
}

// Verify that all imported rows are unchanged and no independent company-scoped
// data has appeared before removing the imported rows and archiving the company.
export async function matchesJournaledMigrationRows(tx: Tx, companyId: string, provenance: unknown): Promise<boolean> {
  const ref = record(provenance);
  if (ref.kind !== "company_migration" || ref.destinationClaimed !== true || ref.destinationCompanyId !== companyId
    || typeof ref.sourceCompanyId !== "string" || !ref.sourceCompanyId || ref.sourceCompanyId === companyId) return false;
  const owner = ref.ownerProvenance === undefined ? null : record(ref.ownerProvenance);
  const agentRows = section(ref.agentProvenance);
  const projectRows = section(ref.projectProvenance);
  const routineRows = section(ref.routineProvenance);
  const assetRows = section(ref.assetProvenance);
  const skillRows = ref.skillProvenance === undefined ? null : record(ref.skillProvenance);
  const issueRows = ref.issueProvenance === undefined ? null : record(ref.issueProvenance);
  const [company] = await tx.select({ fingerprint: migrationCompanyFingerprint })
    .from(companies).where(eq(companies.id, companyId)).for("update");
  if (company?.fingerprint !== fingerprint(issueRows ? issueRows.companyFingerprint : ref.initialCompanyFingerprint)) return false;

  // The fingerprint includes the primary key (including composite keys), so
  // exact multiset comparison detects added, missing, and edited rows.
  const checks: ReadonlyArray<readonly [PgTable & { companyId: AnyPgColumn }, string[]]> = [
    [agents, rows(agentRows)],
    [projects, rows(projectRows)],
    [projectWorkspaces, projectRows.flatMap((row) => rows(row.workspaces))],
    [companyMemberships, [...(owner ? rows([owner.membership]) : []), ...agentRows.flatMap((row) => rows(row.memberships))]],
    [principalPermissionGrants, [...(owner ? rows(owner.grants) : []), ...agentRows.flatMap((row) => rows(row.grants))]],
    [companySecretBindings, [...agentRows, ...projectRows].flatMap((row) => rows(row.secretBindings))],
    [userSecretDeclarations, [...agentRows, ...projectRows].flatMap((row) => rows(row.userSecretDeclarations))],
    [activityLog, agentRows.flatMap((row) => rows(row.audit))],
    [assets, rows(assetRows)],
    [companyLogos, rows(assetRows.flatMap((row) => row.logo === null ? [] : [row.logo]))],
    [issueAttachments, rows(assetRows.flatMap((row) => row.attachment === undefined ? [] : [row.attachment]))],
    [companySkills, skillRows ? rows(skillRows.skills) : []],
    [folders, skillRows ? rows(skillRows.folders) : []],
    [routines, rows(routineRows)],
    [routineTriggers, routineRows.flatMap((row) => rows(row.triggers))],
    [routineRevisions, routineRows.flatMap((row) => rows(row.revisions))],
    [labels, ref.labelProvenance === undefined ? [] : Object.values(record(ref.labelProvenance)).map(fingerprint)],
    [issues, issueRows ? rows(issueRows.issues) : []],
    [issueLabels, issueRows ? rows(issueRows.labels) : []],
    [issueInboxArchives, issueRows ? rows(issueRows.inboxArchives) : []],
    [issueComments, issueRows ? rows(issueRows.comments) : []],
    [documents, issueRows ? rows(issueRows.documents) : []],
    [documentRevisions, issueRows ? rows(issueRows.revisions) : []],
    [issueDocuments, issueRows ? rows(issueRows.documentLinks) : []],
    [issueWorkProducts, issueRows ? rows(issueRows.workProducts) : []],
    [issueRelations, issueRows ? rows(issueRows.relations) : []],
  ];
  for (const [table, expected] of checks) {
    const actual = await tx.select({ fingerprint: migrationRowFingerprint(getTableName(table)) })
      .from(table).where(eq(table.companyId, companyId)).for("update");
    if (actual.length !== expected.length) return false;
    const sorted = actual.map((row) => row.fingerprint).sort();
    if (expected.sort().some((value, index) => value !== sorted[index])) return false;
  }
  // A destination with any other company-scoped data is no longer disposable.
  const tracked = new Set<PgTable>([companies, schema.companyTransferRuns, ...checks.map(([table]) => table)]);
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable) || tracked.has(table) || !("companyId" in table)) continue;
    const scoped = table as PgTable & { companyId: AnyPgColumn };
    const [existing] = await tx.select({ found: sql`1` }).from(scoped).where(eq(scoped.companyId, companyId)).limit(1);
    if (existing) return false;
  }
  const otherRuns = await tx.select({ id: schema.companyTransferRuns.id }).from(schema.companyTransferRuns)
    .where(eq(schema.companyTransferRuns.companyId, companyId)).limit(2);
  return otherRuns.length === 1;
}

export async function archiveJournaledMigrationCompany(tx: Tx, companyId: string) {
  // Delete only the verified child rows. Keep the destination identity and ledger.
  for (const table of [
    issueAttachments, companyLogos, issueRelations, issueWorkProducts, issueInboxArchives, issueLabels,
    issueComments, issueDocuments, documentRevisions, documents, routineTriggers, routineRevisions,
    routines, issues, labels, projectWorkspaces, companySkills, assets, companySecretBindings,
    userSecretDeclarations, activityLog, principalPermissionGrants, companyMemberships, projects, agents,
  ]) {
    await tx.delete(table).where(eq(table.companyId, companyId));
  }
  // The folder parent FK is RESTRICT, so remove leaves before their parents.
  for (;;) {
    const deleted = await tx.delete(folders).where(sql`${folders.companyId} = ${companyId} and not exists (
      select 1 from ${folders} as child where child.parent_id = ${folders.id}
    )`).returning({ id: folders.id });
    if (deleted.length === 0) break;
  }
  const [archived] = await tx.update(companies).set({ status: "archived", updatedAt: new Date() })
    .where(eq(companies.id, companyId)).returning({ id: companies.id });
  if (!archived) throw new Error("Migration destination was not archived");
}
