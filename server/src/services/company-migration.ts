import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { CompanyPortabilityExport } from "@myrmidon/shared";
import type { Db } from "@myrmidon/db";
import { assets, companyLogos, companyMemberships, companySecretBindings, companyTransferRuns, issueAttachments, issueComments, issues, principalPermissionGrants, projects, projectWorkspaces, userSecretDeclarations } from "@myrmidon/db";
import { and, eq, getTableColumns, getTableName, sql } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import type { StorageService } from "../storage/types.js";
import { resolveManagedInstructionsRoot } from "./agent-instructions.js";
import { resolveManagedSkillsRoot } from "./company-skills.js";
import type { companyPortabilityService } from "./company-portability.js";
import { validateMigrationManifest } from "./company-migration-validation.js";
import { companyTransferRunService, migrationRowFingerprint, parseMigrationResource } from "./company-transfer-runs.js";
import { migrationRunKey } from "./company-migration-key.js";
import { grantsForHumanRole } from "./company-member-roles.js";
import { projectService } from "./projects.js";
import { secretService } from "./secrets.js";

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

export async function createMigrationProject(
  db: Db,
  runId: string,
  companyId: string,
  data: Pick<typeof projects.$inferInsert, "name" | "description" | "leadAgentId" | "targetDate" | "color" | "icon" | "status" | "env" | "executionWorkspacePolicy">,
  populate: (
    project: Awaited<ReturnType<ReturnType<typeof projectService>["create"]>>,
    service: Pick<ReturnType<typeof projectService>, "createWorkspace" | "update">,
  ) => Promise<void>,
) {
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

export async function getMigrationStatus(db: Db, sourceCompanyId: string, runId: string) {
  const run = await companyTransferRunService.getRun(db, runId);
  const ref = run?.containerRef;
  if (!run || run.direction !== "import" || typeof ref !== "object" || ref === null || Array.isArray(ref)) return null;
  if (!("kind" in ref) || ref.kind !== "company_migration" || !("sourceCompanyId" in ref) || ref.sourceCompanyId !== sourceCompanyId) return null;
  return { runId: run.id, status: run.status };
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
export async function recoverRemovedMigrationStorage(db: Db, storage: StorageService | undefined, sourceCompanyId: string, runId: string) {
  const ledger = companyTransferRunService;
  const run = await ledger.getRun(db, runId);
  const ref = run?.containerRef as { destinationClaimed?: unknown; destinationCompanyId?: unknown } | null;
  if (run?.companyId !== null || ref?.destinationClaimed !== true || typeof ref.destinationCompanyId !== "string") {
    throw notFound("Migration rollback is not available.");
  }
  const destinationId = ref.destinationCompanyId;
  if (!await ledger.claimMigrationRollback(db, runId, sourceCompanyId, { removedDestinationId: destinationId })) {
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

// The planner remains read-only until live destination recovery is available.
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
    async dryRun(companyId: string, input: CompanyPortabilityExport, newCompanyName: string, collisionStrategy: "rename" | "skip" | "replace" = "rename") {
      return (await prepare(companyId, input, newCompanyName, collisionStrategy)).report;
    },
  };
}
