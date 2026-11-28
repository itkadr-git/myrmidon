import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { CompanyPortabilityExport } from "@myrmidon/shared";
import type { Db } from "@myrmidon/db";
import { activityLog, agents, assets, companies, companyLogos, companyMemberships, companySecretBindings, companySkills, companyTransferRuns, documentRevisions, documents, folders, issueAttachments, issueComments, issueDocuments, issueInboxArchives, issueLabels, issueRelations, issues, issueWorkProducts, labels, principalPermissionGrants, projects, projectWorkspaces, routineRevisions, routines, routineTriggers, userSecretDeclarations } from "@myrmidon/db";
import { and, eq, getTableColumns, getTableName, inArray, sql } from "drizzle-orm";
import { conflict, notFound, unprocessable } from "../errors.js";
import { matchesJournaledMigrationRows, removeJournaledMigrationCompany } from "./company-migration-provenance.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import type { StorageService } from "../storage/types.js";
import { resolveManagedInstructionsRoot } from "./agent-instructions.js";
import { companySkillService, resolveManagedSkillsRoot } from "./company-skills.js";
import type { companyPortabilityService } from "./company-portability.js";
import { validateMigrationManifest } from "./company-migration-validation.js";
import { companyTransferRunService, migrationCompanyFingerprint, migrationRowFingerprint, parseMigrationResource } from "./company-transfer-runs.js";
import { migrationRunKey } from "./company-migration-key.js";
import { grantsForHumanRole } from "./company-member-roles.js";
import { projectService } from "./projects.js";
import { agentService } from "./agents.js";
import { accessService } from "./access.js";
import { secretService } from "./secrets.js";
import { documentService } from "./documents.js";
import { issueService } from "./issues.js";
import { workProductService } from "./work-products.js";
import { routineService } from "./routines.js";
import type { ImportIssueCommentRow, ImportIssueDocumentRow, ImportIssueRow, ImportIssueWorkProductRow } from "./import-write-types.js";

type Portability = ReturnType<typeof companyPortabilityService>;

function applyingDestination(runId: string, companyId: string) {
  return and(
    eq(companyTransferRuns.id, runId),
    eq(companyTransferRuns.companyId, companyId),
    eq(companyTransferRuns.direction, "import"),
    eq(companyTransferRuns.status, "applying"),
    sql`${companyTransferRuns.containerRef}->>'kind' = 'company_migration'`,
    sql`${companyTransferRuns.containerRef}->>'destinationClaimed' = 'true'`,
    sql`${companyTransferRuns.containerRef}->>'destinationCompanyId' = ${companyId}`,
    sql`nullif(${companyTransferRuns.containerRef}->>'sourceCompanyId', '') <> ${companyId}`,
    sql`${companyTransferRuns.actorKey} = 'company_migration:' || (${companyTransferRuns.containerRef}->>'sourceCompanyId')`,
  );
}

export async function provisionMigrationOwner(db: Db, runId: string, companyId: string, actorUserId: string | null | undefined) {
  await db.transaction(async (tx) => {
    const ownedRun = and(applyingDestination(runId, companyId), sql`not (${companyTransferRuns.containerRef} ? 'ownerProvenance')`);
    const [claim] = await tx.select({ id: companyTransferRuns.id })
      .from(companyTransferRuns).where(ownedRun).for("update");
    if (!claim) throw new Error("Migration owner provisioning rejected");

    const principalId = actorUserId ?? "board";
    const [membership] = await tx.insert(companyMemberships).values({
      companyId, principalType: "user", principalId, membershipRole: "owner", status: "active",
    }).returning({ id: companyMemberships.id, fingerprint: migrationRowFingerprint("company_memberships") });
    if (!membership) throw new Error("Migration owner membership was not created");

    const defaults = grantsForHumanRole("owner");
    const grants = defaults.length === 0 ? [] : await tx.insert(principalPermissionGrants).values(
      defaults.map(({ permissionKey, scope }) => ({
        companyId, principalType: "user", principalId, permissionKey, scope: scope ?? null,
        grantedByUserId: actorUserId ?? null,
      })),
    ).returning({ id: principalPermissionGrants.id, fingerprint: migrationRowFingerprint("principal_permission_grants") });
    if (grants.length !== defaults.length) throw new Error("Migration owner grants were not created");

    const [saved] = await tx.update(companyTransferRuns).set({
      containerRef: sql`${companyTransferRuns.containerRef} || jsonb_build_object('ownerProvenance', ${JSON.stringify({ membership, grants })}::jsonb)`,
      updatedAt: new Date(),
    }).where(ownedRun).returning({ id: companyTransferRuns.id });
    if (!saved) throw new Error("Migration owner provenance was not recorded");
  });
}

export async function recordMigrationAsset(
  db: Db,
  runId: string,
  companyId: string,
  data: Omit<typeof assets.$inferInsert, "companyId">,
  placement: boolean | { issueId: string; issueCommentId: string | null },
) {
  const attachment = typeof placement === "object" ? placement : null;
  const logo = placement === true;
  const namespace = attachment ? `issues/${attachment.issueId}` : `assets/${logo ? "companies" : "general"}`;
  const resource = parseMigrationResource(companyId, data.objectKey);
  if (resource?.kind !== "object" || !data.objectKey.startsWith(`${companyId}/${namespace}/`)) {
    throw new Error("Invalid migration asset reservation");
  }
  return db.transaction(async (tx) => {
    const ownedRun = and(
      applyingDestination(runId, companyId),
      sql`${companyTransferRuns.completedParts} @> ${JSON.stringify([data.objectKey])}::jsonb`,
      sql`not (coalesce(${companyTransferRuns.containerRef}->'assetProvenance', '{}'::jsonb) ? ${data.objectKey})`,
    );
    const [claim] = await tx.select({ id: companyTransferRuns.id })
      .from(companyTransferRuns).where(ownedRun).for("update");
    if (!claim) throw new Error("Migration asset recording rejected");

    if (attachment) {
      const [issue] = await tx.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.id, attachment.issueId), eq(issues.companyId, companyId))).for("share");
      if (!issue) throw new Error("Migration attachment issue does not belong to the destination");
      if (attachment.issueCommentId !== null) {
        const [comment] = await tx.select({ id: issueComments.id }).from(issueComments)
          .where(and(eq(issueComments.id, attachment.issueCommentId), eq(issueComments.issueId, issue.id), eq(issueComments.companyId, companyId))).for("share");
        if (!comment) throw new Error("Migration attachment comment does not belong to the issue");
      }
    }

    const [created] = await tx.insert(assets).values({ ...data, companyId }).returning({
      ...getTableColumns(assets), fingerprint: migrationRowFingerprint("assets"),
    });
    if (!created) throw new Error("Migration asset was not created");
    const { fingerprint, ...asset } = created;
    const logoRows = logo ? await tx.insert(companyLogos).values({ companyId, assetId: asset.id }).returning({
      id: companyLogos.id, fingerprint: migrationRowFingerprint("company_logos"),
    }) : [];
    if (logo && logoRows.length !== 1) throw new Error("Migration logo was not created");

    const attachmentRows = attachment ? await tx.insert(issueAttachments).values({
      companyId, assetId: asset.id, issueId: attachment.issueId, issueCommentId: attachment.issueCommentId,
    }).returning({ id: issueAttachments.id, fingerprint: migrationRowFingerprint("issue_attachments") }) : [];
    if (attachment && attachmentRows.length !== 1) throw new Error("Migration attachment was not created");

    const provenance = { [data.objectKey]: {
      id: asset.id, fingerprint, logo: logoRows[0] ?? null,
      ...(attachment ? { attachment: attachmentRows[0] } : {}),
    } };
    const [saved] = await tx.update(companyTransferRuns).set({
      containerRef: sql`${companyTransferRuns.containerRef} || jsonb_build_object('assetProvenance', coalesce(${companyTransferRuns.containerRef}->'assetProvenance', '{}'::jsonb) || ${JSON.stringify(provenance)}::jsonb)`,
      updatedAt: new Date(),
    }).where(ownedRun).returning({ id: companyTransferRuns.id });
    if (!saved) throw new Error("Migration asset provenance was not recorded");
    return asset;
  });
}

export async function createMigrationAgent(
  db: Db,
  runId: string,
  companyId: string,
  data: Omit<typeof agents.$inferInsert, "companyId" | "id"> & { id: string },
  populate: (
    agent: Awaited<ReturnType<ReturnType<typeof agentService>["create"]>>,
    service: Pick<ReturnType<typeof agentService>, "update">,
    access: Pick<ReturnType<typeof accessService>, "ensureMembership" | "setPrincipalPermission">,
  ) => Promise<Awaited<ReturnType<ReturnType<typeof agentService>["create"]>>>,
) {
  const reservation = `${companyId}/managed/instructions/${data.id}`;
  return db.transaction(async (tx) => {
    const ownedRun = and(
      applyingDestination(runId, companyId),
      sql`${companyTransferRuns.completedParts} @> ${JSON.stringify([reservation])}::jsonb`,
      sql`not (coalesce(${companyTransferRuns.containerRef}->'agentProvenance', '{}'::jsonb) ? ${data.id})`,
    );
    const [claim] = await tx.select({ id: companyTransferRuns.id }).from(companyTransferRuns).where(ownedRun).for("update");
    if (!claim) throw new Error("Migration agent recording rejected");

    const txDb = tx as unknown as Db;
    const service = agentService(txDb);
    const created = await service.create(companyId, data);
    const agent = await populate(created, service, accessService(txDb));
    if (agent.id !== created.id || agent.companyId !== companyId) throw new Error("Migration agent identity changed");
    const [row] = await tx.select({ fingerprint: migrationRowFingerprint(getTableName(agents)) })
      .from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agent.id)));
    if (!row) throw new Error("Migration agent was not created");
    const memberships = await tx.select({ id: companyMemberships.id, fingerprint: migrationRowFingerprint(getTableName(companyMemberships)) })
      .from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, agent.id)));
    const grants = await tx.select({ id: principalPermissionGrants.id, fingerprint: migrationRowFingerprint(getTableName(principalPermissionGrants)) })
      .from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalType, "agent"), eq(principalPermissionGrants.principalId, agent.id)));
    const secretBindings = await tx.select({ id: companySecretBindings.id, fingerprint: migrationRowFingerprint(getTableName(companySecretBindings)) })
      .from(companySecretBindings).where(and(eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.targetType, "agent"), eq(companySecretBindings.targetId, agent.id)));
    const declarations = await tx.select({ id: userSecretDeclarations.id, fingerprint: migrationRowFingerprint(getTableName(userSecretDeclarations)) })
      .from(userSecretDeclarations).where(and(eq(userSecretDeclarations.companyId, companyId), eq(userSecretDeclarations.targetType, "agent"), eq(userSecretDeclarations.targetId, agent.id)));
    const audit = await tx.select({ id: activityLog.id, fingerprint: migrationRowFingerprint(getTableName(activityLog)) })
      .from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "agent"), eq(activityLog.entityId, agent.id)));
    const provenance = { [agent.id]: { ...row, memberships, grants, secretBindings, userSecretDeclarations: declarations, audit } };
    const [saved] = await tx.update(companyTransferRuns).set({
      containerRef: sql`${companyTransferRuns.containerRef} || jsonb_build_object('agentProvenance', coalesce(${companyTransferRuns.containerRef}->'agentProvenance', '{}'::jsonb) || ${JSON.stringify(provenance)}::jsonb)`,
      updatedAt: new Date(),
    }).where(ownedRun).returning({ id: companyTransferRuns.id });
    if (!saved) throw new Error("Migration agent provenance was not recorded");
    return agent;
  });
}

export async function linkMigrationAgent(db: Db, runId: string, companyId: string, agentId: string, managerId: string) {
  await db.transaction(async (tx) => {
    const ownedRun = and(
      applyingDestination(runId, companyId),
      sql`(${companyTransferRuns.containerRef}->'agentProvenance') ? ${managerId}`,
    );
    const [claim] = await tx.select({ fingerprint: sql<string | null>`${companyTransferRuns.containerRef}->'agentProvenance'->${agentId}::text->>'fingerprint'` })
      .from(companyTransferRuns).where(ownedRun).for("update");
    const [row] = await tx.select({ fingerprint: migrationRowFingerprint(getTableName(agents)) })
      .from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("update");
    if (!claim?.fingerprint || row?.fingerprint !== claim.fingerprint) {
      throw new Error("Migration reporting link rejected for an unowned or modified agent");
    }
    const updated = await agentService(tx as unknown as Db).update(agentId, { reportsTo: managerId });
    if (!updated) throw new Error("Migration reporting link was not recorded");
    const [linked] = await tx.select({ fingerprint: migrationRowFingerprint(getTableName(agents)) })
      .from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    if (!linked) throw new Error("Migration agent was not found after reporting update");
    const [saved] = await tx.update(companyTransferRuns).set({
      containerRef: sql`jsonb_set(${companyTransferRuns.containerRef}, array['agentProvenance', ${agentId}::text, 'fingerprint'], to_jsonb(${linked.fingerprint}::text))`,
      updatedAt: new Date(),
    }).where(ownedRun).returning({ id: companyTransferRuns.id });
    if (!saved) throw new Error("Migration agent provenance was not updated");
  });
}

export async function createMigrationProject(
  db: Db,
  runId: string,
  companyId: string,
  data: Pick<typeof projects.$inferInsert, "name" | "description" | "leadAgentId" | "targetDate" | "color" | "icon" | "status" | "env" | "executionWorkspacePolicy">,
  populate: (
    project: Awaited<ReturnType<ReturnType<typeof projectService>["create"]>>,
    service: Pick<ReturnType<typeof projectService>, "createWorkspace" | "update">,
  ) => Promise<void>,
): Promise<Awaited<ReturnType<ReturnType<typeof projectService>["create"]>>> {
  return db.transaction(async (tx) => {
    const ownedRun = applyingDestination(runId, companyId);
    const [claim] = await tx.select({ id: companyTransferRuns.id })
      .from(companyTransferRuns).where(ownedRun).for("update");
    if (!claim) throw new Error("Migration project recording rejected");

    // Reuse project naming and primary-workspace rules on the same connection.
    const service = projectService(tx as unknown as Db);
    const project = await service.create(companyId, data);
    await secretService(tx).syncEnvBindingsForTarget(companyId,
      { targetType: "project", targetId: project.id }, data.env ?? {}, { db: tx });
    await populate(project, service);

    const [row] = await tx.select({ fingerprint: migrationRowFingerprint(getTableName(projects)) })
      .from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, project.id)));
    if (!row) throw new Error("Migration project was not created");
    const workspaces = await tx.select({ id: projectWorkspaces.id, fingerprint: migrationRowFingerprint(getTableName(projectWorkspaces)) })
      .from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, project.id)));
    const secretBindings = await tx.select({ id: companySecretBindings.id, fingerprint: migrationRowFingerprint(getTableName(companySecretBindings)) })
      .from(companySecretBindings).where(and(eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.targetType, "project"), eq(companySecretBindings.targetId, project.id)));
    const declarations = await tx.select({ id: userSecretDeclarations.id, fingerprint: migrationRowFingerprint(getTableName(userSecretDeclarations)) })
      .from(userSecretDeclarations).where(and(eq(userSecretDeclarations.companyId, companyId), eq(userSecretDeclarations.targetType, "project"), eq(userSecretDeclarations.targetId, project.id)));

    const provenance = { [project.id]: { ...row, workspaces, secretBindings, userSecretDeclarations: declarations } };
    const [saved] = await tx.update(companyTransferRuns).set({
      containerRef: sql`${companyTransferRuns.containerRef} || jsonb_build_object('projectProvenance', coalesce(${companyTransferRuns.containerRef}->'projectProvenance', '{}'::jsonb) || ${JSON.stringify(provenance)}::jsonb)`,
      updatedAt: new Date(),
    }).where(ownedRun).returning({ id: companyTransferRuns.id });
    if (!saved) throw new Error("Migration project provenance was not recorded");
    return project;
  });
}

export async function createMigrationLabel(
  db: Db, runId: string, companyId: string, input: Pick<typeof labels.$inferInsert, "name" | "color">,
) {
  return db.transaction(async (tx) => {
    const ownedRun = applyingDestination(runId, companyId);
    const [claim] = await tx.select({ id: companyTransferRuns.id }).from(companyTransferRuns).where(ownedRun).for("update");
    if (!claim) throw new Error("Migration label recording rejected");
    const [label] = await tx.insert(labels).values({ companyId, name: input.name.trim(), color: input.color })
      .returning({ ...getTableColumns(labels), fingerprint: migrationRowFingerprint(getTableName(labels)) });
    if (!label) throw new Error("Migration label was not created");
    const { fingerprint, ...row } = label;
    const [saved] = await tx.update(companyTransferRuns).set({
      containerRef: sql`${companyTransferRuns.containerRef} || jsonb_build_object('labelProvenance', coalesce(${companyTransferRuns.containerRef}->'labelProvenance', '{}'::jsonb) || jsonb_build_object(${row.id}::text, ${fingerprint}::text))`,
      updatedAt: new Date(),
    }).where(ownedRun).returning({ id: companyTransferRuns.id });
    if (!saved) throw new Error("Migration label provenance was not recorded");
    return row;
  });
}

export async function createMigrationIssues(db: Db, runId: string, companyId: string, batch: {
  issues: ImportIssueRow[];
  comments: ImportIssueCommentRow[];
  documents: ImportIssueDocumentRow[];
  workProducts: ImportIssueWorkProductRow[];
  relations: Array<{ issueId: string; relatedIssueId: string }>;
  actorUserId?: string | null;
}) {
  const ids = new Set(batch.issues.map(({ id }) => id));
  if ([...batch.comments, ...batch.documents, ...batch.workProducts].some((row) => row.companyId !== companyId || !ids.has(row.issueId)) ||
      batch.relations.some((row) => !ids.has(row.issueId) || !ids.has(row.relatedIssueId))) {
    throw new Error("Migration issue batch refers to an issue outside the batch");
  }
  if (ids.size === 0) return;
  return db.transaction(async (tx) => {
    const ownedRun = and(applyingDestination(runId, companyId), sql`not (${companyTransferRuns.containerRef} ? 'issueProvenance')`);
    const [claim] = await tx.select({ initialFingerprint: sql<string | null>`${companyTransferRuns.containerRef}->>'initialCompanyFingerprint'` })
      .from(companyTransferRuns).where(ownedRun).for("update");
    if (!claim) throw new Error("Migration issue recording rejected");
    const [initialCompany] = await tx.select({ fingerprint: migrationCompanyFingerprint })
      .from(companies).where(eq(companies.id, companyId)).for("update");
    if (!initialCompany || initialCompany.fingerprint !== claim.initialFingerprint) {
      throw new Error("Migration issue destination changed before the batch");
    }
    const txDb = tx as unknown as Db;
    const service = issueService(txDb);
    const issueIds = [...ids];
    await service.importIssues(companyId, batch.issues);
    if (batch.actorUserId) await service.archiveImportedInbox(companyId, issueIds, batch.actorUserId);
    await service.addImportedComments(batch.comments);
    await documentService(txDb).createIssueDocumentsForImport(batch.documents);
    await workProductService(txDb).createManyForImport(batch.workProducts);
    if (batch.relations.length > 0) {
      await tx.insert(issueRelations).values(batch.relations.map((row) => ({
        ...row, companyId, type: "blocks" as const, createdByUserId: batch.actorUserId ?? null,
      }))).onConflictDoNothing();
    }

    // New issue ids are not visible to other transactions before commit. Scope
    // each lookup to those ids, rather than adopting unrelated destination data.
    const [company] = await tx.select({ issueCounter: companies.issueCounter, fingerprint: migrationCompanyFingerprint })
      .from(companies).where(eq(companies.id, companyId));
    if (!company) throw new Error("Migration issue destination missing");
    const documentIds = tx.select({ id: issueDocuments.documentId }).from(issueDocuments)
      .where(and(eq(issueDocuments.companyId, companyId), inArray(issueDocuments.issueId, issueIds)));
    const provenance = {
      issueCounter: company.issueCounter,
      companyFingerprint: company.fingerprint,
      issues: await tx.select({ id: issues.id, fingerprint: migrationRowFingerprint(getTableName(issues)) })
        .from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds))),
      labels: await tx.select({ issueId: issueLabels.issueId, labelId: issueLabels.labelId, fingerprint: migrationRowFingerprint(getTableName(issueLabels)) })
        .from(issueLabels).where(and(eq(issueLabels.companyId, companyId), inArray(issueLabels.issueId, issueIds))),
      inboxArchives: await tx.select({ issueId: issueInboxArchives.issueId, userId: issueInboxArchives.userId, fingerprint: migrationRowFingerprint(getTableName(issueInboxArchives)) })
        .from(issueInboxArchives).where(and(eq(issueInboxArchives.companyId, companyId), inArray(issueInboxArchives.issueId, issueIds))),
      comments: await tx.select({ id: issueComments.id, fingerprint: migrationRowFingerprint(getTableName(issueComments)) })
        .from(issueComments).where(and(eq(issueComments.companyId, companyId), inArray(issueComments.issueId, issueIds))),
      documents: await tx.select({ id: documents.id, fingerprint: migrationRowFingerprint(getTableName(documents)) })
        .from(documents).where(and(eq(documents.companyId, companyId), inArray(documents.id, documentIds))),
      revisions: await tx.select({ id: documentRevisions.id, fingerprint: migrationRowFingerprint(getTableName(documentRevisions)) })
        .from(documentRevisions).where(and(eq(documentRevisions.companyId, companyId), inArray(documentRevisions.documentId, documentIds))),
      documentLinks: await tx.select({ issueId: issueDocuments.issueId, documentId: issueDocuments.documentId, key: issueDocuments.key, fingerprint: migrationRowFingerprint(getTableName(issueDocuments)) })
        .from(issueDocuments).where(and(eq(issueDocuments.companyId, companyId), inArray(issueDocuments.issueId, issueIds))),
      workProducts: await tx.select({ id: issueWorkProducts.id, fingerprint: migrationRowFingerprint(getTableName(issueWorkProducts)) })
        .from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, companyId), inArray(issueWorkProducts.issueId, issueIds))),
      relations: await tx.select({ id: issueRelations.id, fingerprint: migrationRowFingerprint(getTableName(issueRelations)) })
        .from(issueRelations).where(and(eq(issueRelations.companyId, companyId), inArray(issueRelations.issueId, issueIds))),
    };
    const [saved] = await tx.update(companyTransferRuns).set({
      containerRef: sql`${companyTransferRuns.containerRef} || jsonb_build_object('issueProvenance', ${JSON.stringify(provenance)}::jsonb)`,
      updatedAt: new Date(),
    }).where(ownedRun).returning({ id: companyTransferRuns.id });
    if (!saved) throw new Error("Migration issue provenance was not recorded");
  });
}

export async function getMigrationStatus(db: Db, sourceCompanyId: string, runId: string) {
  const run = await companyTransferRunService.getRun(db, runId);
  const ref = run?.containerRef;
  if (!run || run.direction !== "import" || typeof ref !== "object" || ref === null || Array.isArray(ref)) return null;
  if (!("kind" in ref) || ref.kind !== "company_migration" || !("sourceCompanyId" in ref) || ref.sourceCompanyId !== sourceCompanyId) return null;
  return { runId: run.id, status: run.status };
}

export async function importMigrationSkills(db: Db, runId: string, companyId: string, files: Record<string, string>) {
  await companyTransferRunService.reserveMigrationManagedDirectory(db, runId, companyId, { kind: "company_skills" });
  return db.transaction(async (tx) => {
    const ownedRun = applyingDestination(runId, companyId);
    const [claim] = await tx.select({ id: companyTransferRuns.id }).from(companyTransferRuns).where(ownedRun).for("update");
    if (!claim) throw new Error("Migration skill recording rejected");
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("update");
    const existingSkills = await tx.select({ id: companySkills.id }).from(companySkills).where(eq(companySkills.companyId, companyId)).limit(1);
    const folderScope = eq(folders.companyId, companyId);
    const existingFolders = await tx.select({ id: folders.id }).from(folders).where(folderScope).limit(1);
    if (existingSkills.length || existingFolders.length) throw conflict("Migration requires an empty skill library and folder tree.");

    const imported = await companySkillService(tx as unknown as Db).importPackageFiles(companyId, files, { skipInventoryRefresh: true });
    const skills = await tx.select({ id: companySkills.id, fingerprint: migrationRowFingerprint(getTableName(companySkills)) })
      .from(companySkills).where(eq(companySkills.companyId, companyId));
    const skillFolders = await tx.select({ id: folders.id, fingerprint: migrationRowFingerprint(getTableName(folders)) })
      .from(folders).where(folderScope);
    const provenance = { skills, folders: skillFolders };
    const [saved] = await tx.update(companyTransferRuns).set({
      containerRef: sql`${companyTransferRuns.containerRef} || jsonb_build_object('skillProvenance', ${JSON.stringify(provenance)}::jsonb)`,
      updatedAt: new Date(),
    }).where(ownedRun).returning({ id: companyTransferRuns.id });
    if (!saved) throw new Error("Migration skill provenance was not recorded");
    return imported;
  });
}

export async function createMigrationRoutine(
  db: Db,
  runId: string,
  companyId: string,
  populate: (service: Pick<ReturnType<typeof routineService>, "create" | "createTrigger">) =>
    ReturnType<ReturnType<typeof routineService>["create"]>,
) {
  return db.transaction(async (tx) => {
    const ownedRun = applyingDestination(runId, companyId);
    const [claim] = await tx.select({ id: companyTransferRuns.id }).from(companyTransferRuns).where(ownedRun).for("update");
    if (!claim) throw new Error("Migration routine recording rejected");

    const service = routineService(tx as unknown as Db);
    let createdId: string | undefined;
    const created = await populate({
      create: async (targetId, input, actor) => {
        if (createdId || targetId !== companyId || input.env != null) throw new Error("Invalid migration routine creation");
        const routine = await service.create(targetId, { ...input, status: "paused" }, actor);
        createdId = routine.id;
        return routine;
      },
      createTrigger: (routineId, input, actor) => {
        if (routineId !== createdId) throw new Error("Migration trigger must belong to the imported routine");
        // Webhook creation provisions a credential through a provider outside
        // this transaction. Do not import external integrations via migration.
        if (input.kind === "webhook") throw new Error("Webhook triggers are not supported by migration");
        return service.createTrigger(routineId, { ...input, enabled: false }, actor);
      },
    });
    if (created.id !== createdId) throw new Error("Migration routine identity changed");
    const scope = and(eq(routines.companyId, companyId), eq(routines.id, created.id));
    const [row] = await tx.select({ fingerprint: migrationRowFingerprint(getTableName(routines)) }).from(routines).where(scope);
    if (!row) throw new Error("Migration routine was not created");
    const triggers = await tx.select({ id: routineTriggers.id, fingerprint: migrationRowFingerprint(getTableName(routineTriggers)) })
      .from(routineTriggers).where(and(eq(routineTriggers.companyId, companyId), eq(routineTriggers.routineId, created.id)));
    const revisions = await tx.select({ id: routineRevisions.id, fingerprint: migrationRowFingerprint(getTableName(routineRevisions)) })
      .from(routineRevisions).where(and(eq(routineRevisions.companyId, companyId), eq(routineRevisions.routineId, created.id)));
    const provenance = { [created.id]: { ...row, triggers, revisions } };
    const [saved] = await tx.update(companyTransferRuns).set({
      containerRef: sql`${companyTransferRuns.containerRef} || jsonb_build_object('routineProvenance', coalesce(${companyTransferRuns.containerRef}->'routineProvenance', '{}'::jsonb) || ${JSON.stringify(provenance)}::jsonb)`,
      updatedAt: new Date(),
    }).where(ownedRun).returning({ id: companyTransferRuns.id });
    if (!saved) throw new Error("Migration routine provenance was not recorded");
    return created;
  });
}

async function removeManagedDirectory(directory: string) {
  const root = resolvePaperclipInstanceRoot();
  const relative = path.relative(root, directory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Migration directory is outside the managed instance");
  }
  let current = root;
  // The configured instance root is trusted, but do not traverse a symlink
  // in any managed path below it. An absent directory is already cleaned up.
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry) return;
    if (!entry.isDirectory()) throw new Error("Invalid managed migration directory");
  }
  await rm(directory, { recursive: true, force: true });
}

// Only recover storage after the owned destination has been removed. Live
// destinations need a separate transactional provenance check before deletion.
export async function recoverRemovedMigrationStorage(db: Db, storage: StorageService | undefined, sourceCompanyId: string, runId: string, alreadyClaimed = false) {
  const ledger = companyTransferRunService;
  const run = await ledger.getRun(db, runId);
  const ref = run?.containerRef as { destinationClaimed?: unknown; destinationCompanyId?: unknown } | null;
  if (run?.companyId !== null || ref?.destinationClaimed !== true || typeof ref.destinationCompanyId !== "string") {
    throw notFound("Migration rollback is not available.");
  }
  const destinationId = ref.destinationCompanyId;
  if (alreadyClaimed ? run.status !== "rolling_back" : !await ledger.claimMigrationRollback(db, runId, sourceCompanyId, { removedDestinationId: destinationId })) {
    throw conflict("Migration is not available for recovery.");
  }
  try {
    const claimed = await ledger.getRun(db, runId);
    if (!claimed) throw new Error("Migration claim missing");
    const resources = claimed.completedParts.map((part) => {
      const resource = parseMigrationResource(destinationId, part);
      if (!resource) throw new Error("Unsupported migration resource");
      return { part, resource };
    });
    for (const { part, resource } of resources) {
      await db.transaction(async (tx) => {
        // Validate and tentatively acknowledge the reservation before touching
        // storage. The UPDATE holds the run lock and rolls back if deletion
        // throws or the process dies before commit. Deleting twice is safe.
        if (!await ledger.acknowledgeMigrationObjectDeletion(tx, runId, destinationId, part)) {
          throw new Error("Migration storage acknowledgement rejected");
        }
        if (resource.kind === "object") {
          if (!storage) throw new Error("Migration storage unavailable");
          await storage.deleteObject(destinationId, resource.objectKey);
        } else if (resource.kind === "agent_instructions") {
          await removeManagedDirectory(resolveManagedInstructionsRoot({ companyId: destinationId, id: resource.agentId }));
        } else {
          await removeManagedDirectory(resolveManagedSkillsRoot(destinationId));
        }
      });
    }
    if (!await ledger.finishMigrationRollback(db, runId)) throw new Error("Migration settlement rejected");
    return { runId, status: "rolled_back" as const };
  } catch {
    await ledger.releaseMigrationRollbackClaim(db, runId, "storage recovery failed");
    throw conflict("Migration storage recovery failed; inspect the run before retrying.");
  }
}

export async function rollbackCompanyMigration(db: Db, storage: StorageService | undefined, sourceCompanyId: string, runId: string) {
  const ledger = companyTransferRunService;
  const run = await ledger.getRun(db, runId);
  const companyId = run?.companyId;
  if (!companyId) return recoverRemovedMigrationStorage(db, storage, sourceCompanyId, runId);
  try {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      if (!await ledger.claimMigrationRollback(txDb, runId, sourceCompanyId)) throw new Error("Migration claim rejected");
      const claimed = await ledger.getRun(txDb, runId);
      if (!claimed || claimed.companyId !== companyId || !await matchesJournaledMigrationRows(tx, companyId, claimed.containerRef)) {
        throw new Error("Destination differs from the migration journal");
      }
      await removeJournaledMigrationCompany(tx, companyId);
    });
  } catch {
    throw conflict("Migration rollback refused; the destination was not removed.");
  }
  return recoverRemovedMigrationStorage(db, storage, sourceCompanyId, runId, true);
}

export function companyMigrationService(portability: Portability) {
  async function prepare(companyId: string, input: CompanyPortabilityExport, newCompanyName: string, collisionStrategy: "rename" | "skip" | "replace") {
    const exported = await portability.exportBundle(companyId, input, { preview: true, rejectUnknownAgentPermissions: true });
    // Export preserves secret binding metadata that is not present in package files.
    const validation = validateMigrationManifest(exported.manifest);
    for (const blob of exported.manifest.blobs ?? []) {
      const file = exported.files[`blobs/${blob.sha256}`];
      if (!/^[a-f0-9]{64}$/.test(blob.sha256) || typeof file !== "object" || file === null || file.encoding !== "base64" || typeof file.data !== "string") {
        validation.errors.push("A declared blob is missing or invalid.");
        continue;
      }
      const bytes = Buffer.from(file.data, "base64");
      if (bytes.toString("base64") !== file.data || bytes.length !== blob.byteSize || createHash("sha256").update(bytes).digest("hex") !== blob.sha256) {
        validation.errors.push("A declared blob failed integrity validation.");
      }
    }
    // The importer checks every blob path, including files omitted from the manifest.
    for (const [path, file] of Object.entries(exported.files)) {
      if (!path.startsWith("blobs/")) continue;
      const sha = path.slice("blobs/".length);
      if (!/^[a-f0-9]{64}$/.test(sha) || typeof file !== "object" || file === null || file.encoding !== "base64" || typeof file.data !== "string"
        || Buffer.from(file.data, "base64").toString("base64") !== file.data
        || createHash("sha256").update(Buffer.from(file.data, "base64")).digest("hex") !== sha) {
        validation.errors.push("An exported blob failed integrity validation.");
      }
    }
    // Invalid references must not reach the import planner.
    const preview = validation.errors.length === 0 ? await portability.previewImport({
      source: { type: "inline", rootPath: exported.rootPath, files: exported.files },
      target: { mode: "new_company", newCompanyName },
      include: input.include,
      collisionStrategy,
    }, { mode: "board_full" }) : null;
    const report = {
      dryRun: true as const,
      runKey: migrationRunKey({ sourceCompanyId: companyId, targetName: newCompanyName, collisionStrategy, exportOptions: input, files: exported.files, secretBindings: validation.secretBindings }),
      validation: {
        ...validation,
        // Planner messages can contain paths or upstream error details; expose counts only.
        errorCount: validation.errors.length + (preview?.errors.length ?? 0),
        importErrorCount: preview?.errors.length ?? 0,
        errors: [...validation.errors, ...((preview?.errors.length ?? 0) > 0 ? ["Import preview reported errors; inspect the source package."] : [])],
        warningCounts: { export: exported.warnings.length, import: preview?.warnings.length ?? 0 },
        importPreviewSkipped: preview === null,
      },
      counts: {
        agents: exported.manifest.agents.length,
        projects: exported.manifest.projects.length,
        issues: exported.manifest.issues.length,
        skills: exported.manifest.skills.length,
      },
    };
    return { exported, report };
  }

  return {
    async apply(db: Db, companyId: string, input: CompanyPortabilityExport, newCompanyName: string, collisionStrategy: "rename" | "skip" | "replace", actorUserId: string | null) {
      const { exported, report } = await prepare(companyId, input, newCompanyName, collisionStrategy);
      if (report.validation.errorCount > 0) throw unprocessable("Migration validation failed; run a dry-run for the report.");
      if (report.validation.secretBindings.some((binding) => binding.requirement === "required")) {
        throw unprocessable("Migration cannot apply while required secret bindings are unresolved.");
      }
      const ledger = companyTransferRunService;
      const { run, alreadyCompleted } = await ledger.resumeOrCreateMigration(db, companyId, report.runKey);
      const response = { ...report, runId: run.id, dryRun: false as const };
      if (alreadyCompleted) return { ...response, status: "completed", resume: "already_completed" };
      if (!await ledger.claimApply(db, run.id)) throw conflict("Migration is active or requires recovery.", { runId: run.id });
      try {
        await portability.importBundle({
          source: { type: "inline", rootPath: exported.rootPath, files: exported.files },
          target: { mode: "new_company", newCompanyName }, include: input.include, collisionStrategy,
        }, actorUserId, { mode: "board_full", pauseAutomations: true, transferRunId: run.id });
        if (!await ledger.complete(db, run.id)) throw new Error("Migration settlement rejected");
        return { ...response, status: "completed" };
      } catch {
        await ledger.releaseApplyClaim(db, run.id, "migration apply failed");
        throw conflict("Migration apply failed; inspect its status and recover the destination before retrying.", { runId: run.id });
      }
    },
    async dryRun(companyId: string, input: CompanyPortabilityExport, newCompanyName: string, collisionStrategy: "rename" | "skip" | "replace" = "rename") {
      return (await prepare(companyId, input, newCompanyName, collisionStrategy)).report;
    },
  };
}
