import { describe, expect, it } from "vitest";
import { validateMigrationManifest } from "../services/company-migration-validation.js";

describe("migration manifest validation", () => {
  it("rejects custom roles that the destination caste directory cannot restore", () => {
    const agent = { slug: "worker", role: "custom-private-caste", reportsToSlug: null,
      reportsToExistingAgentId: null, reportsToExistingAgentSlug: null, skills: [], permissionGrants: [] };
    const result = validateMigrationManifest({ agents: [agent], skills: [], envInputs: [] });
    expect(result.errors).toContain("An agent has a role that cannot be migrated safely.");
    expect(JSON.stringify(result)).not.toContain("custom-private-caste");
    expect(validateMigrationManifest({ agents: [{ ...agent, role: "engineer" }], skills: [], envInputs: [] }).errors).toEqual([]);
  });

  it("reports missing references and invalid permission keys without exposing secret defaults", () => {
    const manifest = {
      agents: [{ slug: "worker", reportsToSlug: "missing", reportsToExistingAgentId: null,
        reportsToExistingAgentSlug: null, skills: ["missing-skill"],
        permissionGrants: [{ permissionKey: "invalid:permission" }] }],
      skills: [],
      envInputs: [{ key: "API_KEY", agentSlug: "worker", projectSlug: null,
        kind: "secret" as const, requirement: "required" as const, defaultValue: "never-print-this" }],
    };
    const result = validateMigrationManifest(manifest);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("missing"),
      expect.stringContaining("missing-skill"),
      expect.stringContaining("invalid:permission"),
    ]));
    expect(result.secretBindings).toEqual([{ key: "API_KEY", agentSlug: "worker", projectSlug: null, requirement: "required" }]);
    expect(JSON.stringify(result)).not.toContain("never-print-this");
  });

  it("rejects scoped grants without exposing their source identifiers or values", () => {
    const agent = { slug: "worker", reportsToSlug: null, reportsToExistingAgentId: null,
      reportsToExistingAgentSlug: null, skills: [],
      permissionGrants: [{ permissionKey: "tasks:assign", scope: { projectId: "source-private-id" } }] };
    const result = validateMigrationManifest({ agents: [agent], skills: [], envInputs: [] });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("scoped permission that cannot be migrated safely"),
    ]));
    expect(JSON.stringify(result)).not.toContain("source-private-id");
    expect(validateMigrationManifest({ agents: [{ ...agent, permissionGrants: [] }], skills: [], envInputs: [] }).errors).toEqual([]);
  });

  it("rejects secret bindings whose agent or project is absent from the bundle", () => {
    const manifest = {
      agents: [], skills: [], projects: [{ slug: "present" }],
      envInputs: [
        { key: "AGENT_KEY", agentSlug: "missing-agent", projectSlug: null, kind: "secret" as const, requirement: "required" as const },
        { key: "PROJECT_KEY", agentSlug: null, projectSlug: "missing-project", kind: "secret" as const, requirement: "required" as const },
      ],
    };
    const result = validateMigrationManifest(manifest);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("missing-agent"),
      expect.stringContaining("missing-project"),
    ]));
  });

  it("rejects an environment binding scoped to both an agent and a project", () => {
    const result = validateMigrationManifest({
      agents: [{ slug: "worker", reportsToSlug: null, reportsToExistingAgentId: null,
        reportsToExistingAgentSlug: null, skills: [], permissionGrants: [] }],
      skills: [], projects: [{ slug: "project" }],
      envInputs: [{ key: "API_KEY", agentSlug: "worker", projectSlug: "project",
        kind: "secret", requirement: "required" }],
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("Secret binding API_KEY has ambiguous scope"),
    ]));
  });

  it("rejects case-insensitive environment binding collisions in the same scope", () => {
    const input = { key: "API_KEY", agentSlug: "worker", projectSlug: null,
      kind: "secret" as const, requirement: "required" as const };
    const agent = { slug: "worker", reportsToSlug: null, reportsToExistingAgentId: null,
      reportsToExistingAgentSlug: null, skills: [], permissionGrants: [] };
    const manifest = { agents: [agent], skills: [], envInputs: [input, { ...input, key: "api_key" }] };
    expect(validateMigrationManifest(manifest).errors).toEqual(expect.arrayContaining([
      expect.stringContaining("Duplicate environment binding"),
    ]));
    expect(validateMigrationManifest({ ...manifest, envInputs: [input, { ...input, agentSlug: null }] }).errors).toEqual([]);
  });

  it("rejects dangling non-secret environment input references", () => {
    const result = validateMigrationManifest({
      agents: [], skills: [], projects: [],
      envInputs: [
        { key: "HOST", agentSlug: "missing-agent", projectSlug: null, kind: "plain" as const, requirement: "required" as const },
        { key: "PORT", agentSlug: null, projectSlug: "missing-project", kind: "plain" as const, requirement: "required" as const },
      ],
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("missing-agent"), expect.stringContaining("missing-project"),
    ]));
  });

  it("rejects duplicate agent and project slugs before resolving references", () => {
    const agent = { slug: "worker", reportsToSlug: null, reportsToExistingAgentId: null,
      reportsToExistingAgentSlug: null, skills: [], permissionGrants: [] };
    const result = validateMigrationManifest({
      agents: [agent, agent], skills: [], projects: [{ slug: "project" }, { slug: "project" }], envInputs: [],
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("Duplicate agent slug: worker"),
      expect.stringContaining("Duplicate project slug: project"),
    ]));
  });

  it("rejects duplicate skill identities even when no agent references them", () => {
    const result = validateMigrationManifest({
      agents: [], envInputs: [],
      skills: [
        { key: "first", slug: "shared" },
        { key: "first", slug: "other" },
        { key: "third", slug: "shared" },
      ],
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("Duplicate skill key: first"),
      expect.stringContaining("Duplicate skill slug: shared"),
    ]));
  });

  it("rejects a skill key that collides with another skill's slug even without agent references", () => {
    const result = validateMigrationManifest({
      agents: [], envInputs: [],
      skills: [{ key: "shared", slug: "first" }, { key: "second", slug: "shared" }],
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("ambiguous skill identity"),
    ]));
    expect(validateMigrationManifest({
      agents: [], envInputs: [], skills: [{ key: "same", slug: "same" }],
    }).errors).toEqual([]);
  });

  it("rejects an agent skill reference matching different skill keys and slugs", () => {
    const result = validateMigrationManifest({
      agents: [{ slug: "worker", reportsToSlug: null, reportsToExistingAgentId: null,
        reportsToExistingAgentSlug: null, skills: ["shared"], permissionGrants: [] }],
      skills: [{ key: "shared", slug: "first" }, { key: "second", slug: "shared" }],
      envInputs: [],
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("missing or ambiguous skill shared"),
    ]));
  });

  it("validates a large set of agent skill references, counting a matching key and slug once", () => {
    const skills = Array.from({ length: 20000 }, (_, index) => ({ key: `skill-${index}`, slug: `skill-${index}` }));
    const agents = skills.map((skill, index) => ({
      slug: `agent-${index}`, reportsToSlug: null, reportsToExistingAgentId: null,
      reportsToExistingAgentSlug: null, skills: [skill.key], permissionGrants: [],
    }));
    expect(validateMigrationManifest({ agents, skills, envInputs: [] }).errors).toEqual([]);
  });

  it("rejects cycles in the imported management hierarchy", () => {
    const agent = { slug: "worker", reportsToSlug: "boss", reportsToExistingAgentId: null,
      reportsToExistingAgentSlug: null, skills: [], permissionGrants: [] };
    const boss = { ...agent, slug: "boss", reportsToSlug: "worker" };
    const manifest = { agents: [agent, boss], skills: [], envInputs: [] };
    expect(validateMigrationManifest(manifest).errors).toEqual(
      expect.arrayContaining([expect.stringContaining("management cycle")]),
    );
    expect(validateMigrationManifest({ ...manifest, agents: [{ ...agent, reportsToSlug: "worker" }] }).errors)
      .toEqual(expect.arrayContaining([expect.stringContaining("management cycle")]));
  });

  it("rejects task conversations without exposing their contents", () => {
    const issue = { slug: "task", projectSlug: null, assigneeAgentSlug: null,
      parentSlug: null, blockedBy: [], comments: [{ body: "private conversation", authorType: "user" as const,
        authorAgentSlug: null, authorUserId: null, presentation: null, metadata: null, createdAt: null }] };
    const result = validateMigrationManifest({ agents: [], skills: [], envInputs: [], issues: [issue] });
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("comments that cannot be migrated")]));
    expect(JSON.stringify(result)).not.toContain("private conversation");
  });

  it("rejects recurring tasks with webhook triggers without exposing trigger metadata", () => {
    const issue = { slug: "scheduled-task", projectSlug: null, assigneeAgentSlug: null,
      parentSlug: null, blockedBy: [], recurring: true,
      routine: { concurrencyPolicy: null, catchUpPolicy: null, triggers: [{
        kind: "webhook", label: "private-webhook-label", enabled: true,
        cronExpression: null, timezone: null, signingMode: "bearer", replayWindowSec: 300,
      }] } };
    const result = validateMigrationManifest({ agents: [], skills: [], envInputs: [], issues: [issue] });
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("webhook trigger")]));
    expect(JSON.stringify(result)).not.toContain("private-webhook-label");
    const safe = { ...issue, routine: { ...issue.routine, triggers: [] } };
    expect(validateMigrationManifest({ agents: [], skills: [], envInputs: [], issues: [safe] }).errors).toEqual([]);
  });

  it("rejects ambiguous and dangling workspace references before import", () => {
    const issue = { slug: "task", projectSlug: "project", projectWorkspaceKey: "missing",
      assigneeAgentSlug: null, parentSlug: null, blockedBy: [] };
    const manifest = { agents: [], skills: [], envInputs: [],
      projects: [{ slug: "project", workspaces: [{ key: "shared" }, { key: "shared" }] }],
      issues: [issue] };
    expect(validateMigrationManifest(manifest).errors).toEqual(expect.arrayContaining([
      expect.stringContaining("duplicate workspace key"),
      expect.stringContaining("missing or ambiguous workspace"),
    ]));
    expect(validateMigrationManifest({ ...manifest,
      projects: [{ slug: "project", workspaces: [{ key: "shared" }] }],
      issues: [{ ...issue, projectWorkspaceKey: "shared" }],
    }).errors).toEqual([]);
    expect(validateMigrationManifest({ ...manifest, projects: [],
      issues: [{ ...issue, projectSlug: null, projectWorkspaceKey: "shared" }],
    }).errors).toEqual(expect.arrayContaining([expect.stringContaining("missing or ambiguous workspace")]));
  });

  it("rejects dangling project and task relationships before migration", () => {
    const result = validateMigrationManifest({
      agents: [], skills: [], envInputs: [],
      projects: [{ slug: "project", ownerAgentSlug: "absent", leadAgentSlug: null }],
      issues: [{ slug: "task", projectSlug: "missing-project", assigneeAgentSlug: "missing-agent",
        parentSlug: "missing-parent", blockedBy: ["missing-blocker"] }],
    });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("absent"), expect.stringContaining("missing-project"),
      expect.stringContaining("missing-agent"), expect.stringContaining("missing-parent"),
      expect.stringContaining("missing-blocker"),
    ]));
  });

  it("rejects cycles in imported task parent relationships", () => {
    const issue = { slug: "first", projectSlug: null, assigneeAgentSlug: null,
      parentSlug: "second", blockedBy: [] };
    const result = validateMigrationManifest({
      agents: [], skills: [], envInputs: [],
      issues: [issue, { ...issue, slug: "second", parentSlug: "first" }],
    });
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("parent cycle")]));
    const selfParent = validateMigrationManifest({
      agents: [], skills: [], envInputs: [], issues: [{ ...issue, parentSlug: "first" }],
    });
    expect(selfParent.errors).toEqual(expect.arrayContaining([expect.stringContaining("parent cycle")]));
  });

  it("validates a long acyclic task parent chain without repeated traversal", () => {
    const issues = Array.from({ length: 20000 }, (_, index) => ({
      slug: `task-${index}`, projectSlug: null, assigneeAgentSlug: null,
      parentSlug: index === 0 ? null : `task-${index - 1}`, blockedBy: [],
    }));
    expect(validateMigrationManifest({ agents: [], skills: [], envInputs: [], issues }).errors).toEqual([]);
  });

  it("rejects cycles in imported task blocker relationships", () => {
    const issue = { slug: "first", projectSlug: null, assigneeAgentSlug: null,
      parentSlug: null, blockedBy: ["second"] };
    const manifest = {
      agents: [], skills: [], envInputs: [],
      issues: [issue, { ...issue, slug: "second", blockedBy: ["first"] }],
    };
    expect(validateMigrationManifest(manifest).errors)
      .toEqual(expect.arrayContaining([expect.stringContaining("blocker cycle")]));
    expect(validateMigrationManifest({ ...manifest, issues: [{ ...issue, blockedBy: ["first"] }] }).errors)
      .toEqual(expect.arrayContaining([expect.stringContaining("blocker cycle")]));
  });

  it("accepts a shared dependency in an acyclic blocker graph", () => {
    const issue = (slug: string, blockedBy: string[]) => ({
      slug, projectSlug: null, assigneeAgentSlug: null, parentSlug: null, blockedBy,
    });
    const result = validateMigrationManifest({
      agents: [], skills: [], envInputs: [],
      issues: [issue("root", ["left", "right"]), issue("left", ["shared"]),
        issue("right", ["shared"]), issue("shared", [])],
    });
    expect(result.errors).toEqual([]);
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
