import type { CompanyPortabilityExport } from "@myrmidon/shared";
import type { companyPortabilityService } from "./company-portability.js";
import { validateMigrationManifest } from "./company-migration-validation.js";

type Portability = ReturnType<typeof companyPortabilityService>;

// This entry point is intentionally read-only; apply and rollback are not yet available.
export function companyMigrationService(portability: Portability) {
  return {
    async dryRun(companyId: string, input: CompanyPortabilityExport, newCompanyName: string) {
      const exported = await portability.exportBundle(companyId, input, { preview: true });
      // Export preserves secret binding metadata that is not present in package files.
      const validation = validateMigrationManifest(exported.manifest);
      // Invalid references must not reach the import planner.
      const preview = validation.errors.length === 0 ? await portability.previewImport({
        source: { type: "inline", rootPath: exported.rootPath, files: exported.files },
        target: { mode: "new_company", newCompanyName },
        include: input.include,
        collisionStrategy: "rename",
      }, { mode: "board_full" }) : null;
      return {
        dryRun: true as const,
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
    },
  };
}
