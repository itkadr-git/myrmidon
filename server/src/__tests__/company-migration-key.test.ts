import { describe, expect, it } from "vitest";
import { migrationRunKey } from "../services/company-migration-key.js";

describe("migration run identity", () => {
  const request = {
    sourceCompanyId: "source-a",
    targetName: "Destination",
    collisionStrategy: "rename" as const,
    exportOptions: { include: { agents: true, projects: true } },
    files: { "COMPANY.md": "company", "agents/worker.md": "worker" },
  };

  it("does not depend on object insertion order", () => {
    const reordered = {
      ...request,
      exportOptions: { include: { projects: true, agents: true } },
      files: { "agents/worker.md": "worker", "COMPANY.md": "company" },
    };
    expect(migrationRunKey(reordered)).toBe(migrationRunKey(request));
  });

  it("distinguishes source, destination, options and package contents", () => {
    const key = migrationRunKey(request);
    expect(migrationRunKey({ ...request, sourceCompanyId: "source-b" })).not.toBe(key);
    expect(migrationRunKey({ ...request, targetName: "Other" })).not.toBe(key);
    expect(migrationRunKey({ ...request, collisionStrategy: "skip" })).not.toBe(key);
    expect(migrationRunKey({ ...request, exportOptions: { include: { agents: false } } })).not.toBe(key);
    expect(migrationRunKey({ ...request, files: { ...request.files, "agents/worker.md": "changed" } })).not.toBe(key);
  });

  it("treats secret bindings as an unordered set of metadata", () => {
    const bindings = [
      { key: "TOKEN", agentSlug: "worker", projectSlug: null, requirement: "required" },
      { key: "PASSWORD", agentSlug: null, projectSlug: "project", requirement: "optional" },
    ];
    const first = migrationRunKey({ ...request, secretBindings: bindings });
    expect(migrationRunKey({ ...request, secretBindings: [...bindings].reverse() })).toBe(first);
    expect(migrationRunKey({ ...request, secretBindings: [bindings[0]!] })).not.toBe(first);
  });

  it("preserves array order and does not expose package content in the key", () => {
    const secret = "sensitive-package-content";
    const first = migrationRunKey({ ...request, exportOptions: { agents: ["a", "b"] }, files: { "agent.md": secret } });
    const second = migrationRunKey({ ...request, exportOptions: { agents: ["b", "a"] }, files: { "agent.md": secret } });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(secret);
    expect(first).not.toBe(second);
  });
});
