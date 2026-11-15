import { PERMISSION_KEYS } from "@myrmidon/shared";
import type { CompanyPortabilityManifest } from "@myrmidon/shared";

type MigrationManifest = {
  agents: Array<Pick<CompanyPortabilityManifest["agents"][number],
    "slug" | "reportsToSlug" | "reportsToExistingAgentId" | "reportsToExistingAgentSlug" | "skills"> & {
      permissionGrants: Array<{ permissionKey: string }>;
    }>;
  skills: Array<Pick<CompanyPortabilityManifest["skills"][number], "key" | "slug">>;
  projects?: Array<Pick<CompanyPortabilityManifest["projects"][number], "slug">>;
  envInputs: Array<Pick<CompanyPortabilityManifest["envInputs"][number],
    "key" | "agentSlug" | "projectSlug" | "kind" | "requirement">>;
};

// This validates a new-company migration; existing target references are never portable.
export function validateMigrationManifest(manifest: MigrationManifest) {
  const errors: string[] = [];
  const agentSlugs = new Set<string>();
  for (const agent of manifest.agents) {
    if (agentSlugs.has(agent.slug)) errors.push(`Duplicate agent slug: ${agent.slug}.`);
    agentSlugs.add(agent.slug);
  }
  const validPermissions: ReadonlySet<string> = new Set(PERMISSION_KEYS);
  const managers = new Map(manifest.agents.map((agent) => [agent.slug, agent.reportsToSlug]));
  const checked = new Set<string>();
  for (const agent of manifest.agents) {
    const path = new Set<string>();
    let current: string | null | undefined = agent.slug;
    while (current && managers.has(current) && !checked.has(current)) {
      if (path.has(current)) {
        errors.push(`Agent ${current} is part of a management cycle.`);
        break;
      }
      path.add(current);
      current = managers.get(current);
    }
    for (const slug of path) checked.add(slug);
  }
  for (const agent of manifest.agents) {
    if (agent.reportsToSlug && !agentSlugs.has(agent.reportsToSlug)) {
      errors.push(`Agent ${agent.slug} references missing manager ${agent.reportsToSlug}.`);
    }
    if (agent.reportsToExistingAgentId || agent.reportsToExistingAgentSlug) {
      errors.push(`Agent ${agent.slug} references an external agent in a new-company migration.`);
    }
    for (const skill of agent.skills) {
      const matches = manifest.skills.filter((entry) => entry.key === skill || entry.slug === skill);
      if (matches.length !== 1) errors.push(`Agent ${agent.slug} references missing or ambiguous skill ${skill}.`);
    }
    for (const grant of agent.permissionGrants) {
      if (!validPermissions.has(grant.permissionKey)) {
        errors.push(`Agent ${agent.slug} has invalid permission ${grant.permissionKey}.`);
      }
    }
  }
  const projectSlugs = new Set<string>();
  for (const project of manifest.projects ?? []) {
    if (projectSlugs.has(project.slug)) errors.push(`Duplicate project slug: ${project.slug}.`);
    projectSlugs.add(project.slug);
  }
  for (const input of manifest.envInputs) {
    if (input.kind !== "secret") continue;
    if (input.agentSlug && !agentSlugs.has(input.agentSlug)) {
      errors.push(`Secret binding ${input.key} references missing agent ${input.agentSlug}.`);
    }
    if (input.projectSlug && !projectSlugs.has(input.projectSlug)) {
      errors.push(`Secret binding ${input.key} references missing project ${input.projectSlug}.`);
    }
  }
  const secretBindings = manifest.envInputs.filter((input) => input.kind === "secret").map((input) => ({
    key: input.key,
    agentSlug: input.agentSlug,
    projectSlug: input.projectSlug,
    requirement: input.requirement,
  }));
  return { errors, secretBindings };
}
