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
        validation: { ...validation, errors: [...validation.errors, ...(preview?.errors ?? [])] },
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
