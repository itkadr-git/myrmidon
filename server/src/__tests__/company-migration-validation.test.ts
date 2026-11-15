import { describe, expect, it } from "vitest";
import { validateMigrationManifest } from "../services/company-migration-validation.js";

describe("migration manifest validation", () => {
  it("reports missing references and invalid permission keys without exposing secret defaults", () => {
    const result = validateMigrationManifest({
      agents: [{ slug: "worker", reportsToSlug: "missing", reportsToExistingAgentId: null,
        reportsToExistingAgentSlug: null, skills: ["missing-skill"],
        permissionGrants: [{ permissionKey: "invalid:permission" }] }],
      skills: [],
      envInputs: [{ key: "API_KEY", agentSlug: "worker", projectSlug: null,
        kind: "secret", requirement: "required", defaultValue: "never-print-this" }],
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("missing"),
      expect.stringContaining("missing-skill"),
      expect.stringContaining("invalid:permission"),
    ]));
    expect(result.secretBindings).toEqual([{ key: "API_KEY", agentSlug: "worker", projectSlug: null, requirement: "required" }]);
    expect(JSON.stringify(result)).not.toContain("never-print-this");
  });

  it("accepts references inside the package and rejects cross-company references", () => {
    const agent = { slug: "worker", reportsToSlug: "boss", reportsToExistingAgentId: null,
      reportsToExistingAgentSlug: null, skills: ["skill-key"], permissionGrants: [] };
    const boss = { ...agent, slug: "boss", reportsToSlug: null, skills: [] };
    const manifest = { agents: [agent, boss], skills: [{ key: "skill-key", slug: "skill" }], envInputs: [] };
    expect(validateMigrationManifest(manifest).errors).toEqual([]);
    expect(validateMigrationManifest({ ...manifest, agents: [{ ...agent, reportsToExistingAgentId: "external" }, boss] }).errors)
      .toEqual(expect.arrayContaining([expect.stringContaining("external agent")]));
  });
});
