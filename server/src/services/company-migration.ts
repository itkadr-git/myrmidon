import { createHash } from "node:crypto";
import type { CompanyPortabilityExport } from "@myrmidon/shared";
import type { Db } from "@myrmidon/db";
import type { companyPortabilityService } from "./company-portability.js";
import { validateMigrationManifest } from "./company-migration-validation.js";
import { companyTransferRunService } from "./company-transfer-runs.js";
import { migrationRunKey } from "./company-migration-key.js";

type Portability = ReturnType<typeof companyPortabilityService>;

export async function getMigrationStatus(db: Db, sourceCompanyId: string, runId: string) {
  const run = await companyTransferRunService.getRun(db, runId);
  const ref = run?.containerRef;
  if (!run || run.direction !== "import" || typeof ref !== "object" || ref === null || Array.isArray(ref)) return null;
  if (!("kind" in ref) || ref.kind !== "company_migration" || !("sourceCompanyId" in ref) || ref.sourceCompanyId !== sourceCompanyId) return null;
  return { runId: run.id, status: run.status };
}

// This entry point is intentionally read-only; apply and rollback are not yet available.
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
