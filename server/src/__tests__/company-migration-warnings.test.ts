import { describe, expect, it, vi } from "vitest";
import { companyMigrationService } from "../services/company-migration.js";
import type { companyPortabilityService } from "../services/company-portability.js";

describe("migration dry-run warnings", () => {
  it("changes the run key when secret binding metadata changes even if package files do not", async () => {
    const manifest = { agents: [], projects: [], issues: [], skills: [], envInputs: [
      { key: "TOKEN", agentSlug: null, projectSlug: null, kind: "secret", requirement: "required" },
    ] };
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({ rootPath: "package", files: {}, manifest, warnings: [] }),
      previewImport: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
    } as unknown as ReturnType<typeof companyPortabilityService>;
    const service = companyMigrationService(portability);
    const first = await service.dryRun("source", {}, "destination");
    manifest.envInputs[0]!.requirement = "optional";
    const second = await service.dryRun("source", {}, "destination");
    expect(first.runKey).not.toBe(second.runKey);
  });

  it("forwards the requested collision strategy to the import planner", async () => {
    const manifest = { agents: [], projects: [], issues: [], skills: [], envInputs: [] };
    const previewImport = vi.fn().mockResolvedValue({ errors: [], warnings: [] });
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({ rootPath: "package", files: {}, manifest, warnings: [] }),
      previewImport,
    } as unknown as ReturnType<typeof companyPortabilityService>;
    await companyMigrationService(portability).dryRun("source", {}, "destination", "skip");
    expect(previewImport).toHaveBeenCalledWith(expect.objectContaining({ collisionStrategy: "skip" }), { mode: "board_full" });
  });

  it("requests a read-only export and never applies the bundle", async () => {
    const manifest = { agents: [], projects: [], issues: [], skills: [], envInputs: [] };
    const exportBundle = vi.fn().mockResolvedValue({ rootPath: "package", files: {}, manifest, warnings: [] });
    const importBundle = vi.fn();
    const portability = {
      exportBundle,
      importBundle,
      previewImport: vi.fn().mockResolvedValue({ errors: [], warnings: [] }),
    } as unknown as ReturnType<typeof companyPortabilityService>;
    const input = { include: { projects: true } };

    await companyMigrationService(portability).dryRun("source", input, "destination");

    expect(exportBundle).toHaveBeenCalledWith("source", input, { preview: true, rejectUnknownAgentPermissions: true });
    expect(importBundle).not.toHaveBeenCalled();
  });

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

  it("rejects a corrupted exported blob before import preview", async () => {
    const manifest = {
      agents: [], projects: [], issues: [], skills: [], envInputs: [],
      blobs: [{ sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", byteSize: 3, contentType: "application/octet-stream" }],
    };
    const previewImport = vi.fn().mockResolvedValue({ errors: [], warnings: [] });
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({
        rootPath: "package", manifest, warnings: [],
        files: { [`blobs/${manifest.blobs[0]!.sha256}`]: { encoding: "base64", data: Buffer.from("bad").toString("base64") } },
      }),
      previewImport,
    } as unknown as ReturnType<typeof companyPortabilityService>;
    const result = await companyMigrationService(portability).dryRun("source", {}, "destination");
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.importPreviewSkipped).toBe(true);
    expect(previewImport).not.toHaveBeenCalled();
  });

  it("rejects non-canonical base64 even when decoded blob bytes match", async () => {
    const sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const manifest = { agents: [], projects: [], issues: [], skills: [], envInputs: [],
      blobs: [{ sha256: sha, byteSize: 3, contentType: "application/octet-stream" }] };
    const previewImport = vi.fn();
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({
        rootPath: "package", manifest, warnings: [],
        files: { [`blobs/${sha}`]: { encoding: "base64", data: "YWJj!!" } },
      }),
      previewImport,
    } as unknown as ReturnType<typeof companyPortabilityService>;
    const result = await companyMigrationService(portability).dryRun("source", {}, "destination");
    expect(result.validation.errorCount).toBeGreaterThan(0);
    expect(result.validation.importPreviewSkipped).toBe(true);
    expect(previewImport).not.toHaveBeenCalled();
  });

  it("rejects an undeclared corrupted blob before import preview", async () => {
    const sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const manifest = { agents: [], projects: [], issues: [], skills: [], envInputs: [], blobs: [] };
    const previewImport = vi.fn().mockResolvedValue({ errors: [], warnings: [] });
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({
        rootPath: "package", manifest, warnings: [],
        files: { [`blobs/${sha}`]: { encoding: "base64", data: Buffer.from("bad").toString("base64") } },
      }),
      previewImport,
    } as unknown as ReturnType<typeof companyPortabilityService>;
    const result = await companyMigrationService(portability).dryRun("source", {}, "destination");
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.importPreviewSkipped).toBe(true);
    expect(previewImport).not.toHaveBeenCalled();
  });

  it("rejects blob entries with missing base64 data without throwing", async () => {
    const sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const manifest = { agents: [], projects: [], issues: [], skills: [], envInputs: [],
      blobs: [{ sha256: sha, byteSize: 3, contentType: "application/octet-stream" }] };
    const previewImport = vi.fn();
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({
        rootPath: "package", manifest, warnings: [],
        files: { [`blobs/${sha}`]: { encoding: "base64" } },
      }),
      previewImport,
    } as unknown as ReturnType<typeof companyPortabilityService>;
    const result = await companyMigrationService(portability).dryRun("source", {}, "destination");
    expect(result.validation.errorCount).toBeGreaterThan(0);
    expect(result.validation.importPreviewSkipped).toBe(true);
    expect(previewImport).not.toHaveBeenCalled();
  });

  it("does not pass webhook integrations or their metadata to the import planner", async () => {
    const manifest = {
      agents: [], projects: [], skills: [], envInputs: [],
      issues: [{ slug: "scheduled-task", projectSlug: null, assigneeAgentSlug: null,
        parentSlug: null, blockedBy: [], recurring: true,
        routine: { triggers: [{ kind: "webhook", label: "private-webhook-canary" }] } }],
    };
    const previewImport = vi.fn();
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({ rootPath: "package", files: {}, manifest, warnings: [] }),
      previewImport,
    } as unknown as ReturnType<typeof companyPortabilityService>;

    const result = await companyMigrationService(portability).dryRun("source", {}, "destination");

    expect(result.validation.errors).toEqual(expect.arrayContaining([expect.stringContaining("webhook trigger")]));
    expect(result.validation.importPreviewSkipped).toBe(true);
    expect(previewImport).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-webhook-canary");
  });

  it("does not pass task work products with external references to the import planner", async () => {
    const manifest = {
      agents: [], projects: [], skills: [], envInputs: [],
      issues: [{ slug: "task", projectSlug: null, assigneeAgentSlug: null,
        parentSlug: null, blockedBy: [], workProducts: [{ type: "pull_request", provider: "github",
          url: "https://example.com/private-reference", metadata: { token: "private-canary" } }] }],
    };
    const previewImport = vi.fn();
    const portability = {
      exportBundle: vi.fn().mockResolvedValue({ rootPath: "package", files: {}, manifest, warnings: [] }),
      previewImport,
    } as unknown as ReturnType<typeof companyPortabilityService>;

    const result = await companyMigrationService(portability).dryRun("source", {}, "destination");

    expect(result.validation.errors).toEqual(expect.arrayContaining([expect.stringContaining("work products")]));
    expect(result.validation.importPreviewSkipped).toBe(true);
    expect(previewImport).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-canary");
    expect(JSON.stringify(result)).not.toContain("private-reference");
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
