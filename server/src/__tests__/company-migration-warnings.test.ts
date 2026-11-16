import { describe, expect, it, vi } from "vitest";
import { companyMigrationService } from "../services/company-migration.js";
import type { companyPortabilityService } from "../services/company-portability.js";

describe("migration dry-run warnings", () => {
  it("reports warning counts without exposing raw export or import messages", async () => {
    const manifest = { agents: [], projects: [], issues: [], skills: [], envInputs: [] };
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({ rootPath: "package", files: {}, manifest, warnings: ["sensitive export detail"] }),
      previewImport: vi.fn().mockResolvedValue({ errors: [], warnings: ["sensitive import detail", "another warning"] }),
    } as unknown as ReturnType<typeof companyPortabilityService>;
    const result = await companyMigrationService(portability).dryRun("source", {}, "destination");
    expect(result.validation.warningCounts).toEqual({ export: 1, import: 2 });
    expect(result.validation.importPreviewSkipped).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("does not expose raw import planner errors", async () => {
    const manifest = { agents: [], projects: [], issues: [], skills: [], envInputs: [] };
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({ rootPath: "package", files: {}, manifest, warnings: [] }),
      previewImport: vi.fn().mockResolvedValue({ errors: ["sensitive planner detail"], warnings: [] }),
    } as unknown as ReturnType<typeof companyPortabilityService>;
    const result = await companyMigrationService(portability).dryRun("source", {}, "destination");
    expect(result.validation.importErrorCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("sensitive planner detail");
  });

  it("distinguishes skipped import validation from a warning-free preview", async () => {
    const manifest = { agents: [], projects: [], issues: [], skills: [], envInputs: [
      { key: "TOKEN", agentSlug: "missing", projectSlug: null, kind: "secret", requirement: "required" },
    ] };
    const previewImport = vi.fn();
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({ rootPath: "package", files: {}, manifest, warnings: [] }),
      previewImport,
    } as unknown as ReturnType<typeof companyPortabilityService>;
    const result = await companyMigrationService(portability).dryRun("source", {}, "destination");
    expect(result.validation.importPreviewSkipped).toBe(true);
    expect(result.validation.warningCounts).toEqual({ export: 0, import: 0 });
    expect(previewImport).not.toHaveBeenCalled();
  });
});
