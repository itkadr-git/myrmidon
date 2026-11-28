import { AGENT_ROLES, PERMISSION_KEYS } from "@myrmidon/shared";
import type { CompanyPortabilityManifest } from "@myrmidon/shared";

type MigrationManifest = {
  agents: Array<Pick<CompanyPortabilityManifest["agents"][number],
    "slug" | "reportsToSlug" | "reportsToExistingAgentId" | "reportsToExistingAgentSlug" | "skills"> & {
      role?: string;
      permissionGrants: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>;
    }>;
  skills: Array<Pick<CompanyPortabilityManifest["skills"][number], "key" | "slug">>;
  projects?: Array<Pick<CompanyPortabilityManifest["projects"][number], "slug"> &
    Partial<Pick<CompanyPortabilityManifest["projects"][number], "ownerAgentSlug" | "leadAgentSlug">> & {
      workspaces?: Array<Pick<CompanyPortabilityManifest["projects"][number]["workspaces"][number], "key">>;
    }>;
  issues?: Array<Pick<CompanyPortabilityManifest["issues"][number],
    "slug" | "projectSlug" | "assigneeAgentSlug" | "parentSlug" | "blockedBy"> &
    Partial<Pick<CompanyPortabilityManifest["issues"][number], "recurring" | "routine" | "comments" | "workProducts" | "projectWorkspaceKey">>>;
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
  const skillKeys = new Set<string>();
  const skillSlugs = new Set<string>();
  const skillIdentityOwners = new Map<string, Set<number>>();
  for (const [index, skill] of manifest.skills.entries()) {
    if (skillKeys.has(skill.key)) errors.push(`Duplicate skill key: ${skill.key}.`);
    if (skillSlugs.has(skill.slug)) errors.push(`Duplicate skill slug: ${skill.slug}.`);
    skillKeys.add(skill.key);
    skillSlugs.add(skill.slug);
    for (const identity of new Set([skill.key, skill.slug])) {
      const owners = skillIdentityOwners.get(identity) ?? new Set<number>();
      owners.add(index);
      skillIdentityOwners.set(identity, owners);
    }
  }
  for (const owners of skillIdentityOwners.values()) {
    if (owners.size > 1) errors.push("Package has an ambiguous skill identity.");
  }
  const validPermissions: ReadonlySet<string> = new Set(PERMISSION_KEYS);
  const portableRoles: ReadonlySet<string> = new Set(AGENT_ROLES);
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
    // Custom caste definitions are not part of the portability bundle.
    if (agent.role !== undefined && !portableRoles.has(agent.role)) {
      errors.push("An agent has a role that cannot be migrated safely.");
    }
    if (agent.reportsToSlug && !agentSlugs.has(agent.reportsToSlug)) {
      errors.push(`Agent ${agent.slug} references missing manager ${agent.reportsToSlug}.`);
    }
    if (agent.reportsToExistingAgentId || agent.reportsToExistingAgentSlug) {
      errors.push(`Agent ${agent.slug} references an external agent in a new-company migration.`);
    }
    for (const skill of agent.skills) {
      if (skillIdentityOwners.get(skill)?.size !== 1) errors.push(`Agent ${agent.slug} references missing or ambiguous skill ${skill}.`);
    }
    for (const grant of agent.permissionGrants) {
      if (!validPermissions.has(grant.permissionKey)) {
        errors.push(`Agent ${agent.slug} has invalid permission ${grant.permissionKey}.`);
      }
      // Grant scopes contain source-company identifiers; importing them unchanged
      // would either break access or accidentally refer to unrelated resources.
      if (grant.scope && Object.keys(grant.scope).length > 0) {
        errors.push(`Agent ${agent.slug} has a scoped permission that cannot be migrated safely.`);
      }
    }
  }
  const projectSlugs = new Set<string>();
  const workspaceKeys = new Map<string, Map<string, number>>();
  for (const project of manifest.projects ?? []) {
    if (projectSlugs.has(project.slug)) errors.push(`Duplicate project slug: ${project.slug}.`);
    projectSlugs.add(project.slug);
    const keys = new Map<string, number>();
    for (const workspace of project.workspaces ?? []) {
      keys.set(workspace.key, (keys.get(workspace.key) ?? 0) + 1);
      if (keys.get(workspace.key) === 2) errors.push(`Project ${project.slug} has a duplicate workspace key.`);
    }
    workspaceKeys.set(project.slug, keys);
  }
  for (const project of manifest.projects ?? []) {
    for (const agentSlug of [project.ownerAgentSlug, project.leadAgentSlug]) {
      if (agentSlug && !agentSlugs.has(agentSlug)) errors.push(`Project ${project.slug} references missing agent ${agentSlug}.`);
    }
  }
  const issueSlugs = new Set<string>();
  for (const issue of manifest.issues ?? []) {
    if (issueSlugs.has(issue.slug)) errors.push(`Duplicate task slug: ${issue.slug}.`);
    issueSlugs.add(issue.slug);
  }
  const parentByIssue = new Map((manifest.issues ?? []).map((issue) => [issue.slug, issue.parentSlug ?? null]));
  const checkedParents = new Set<string>();
  for (const issue of manifest.issues ?? []) {
    // The portability importer copies issue conversations; migration must not.
    if ((issue.comments?.length ?? 0) > 0) {
      errors.push(`Task ${issue.slug} has comments that cannot be migrated.`);
    }
    // Work products can carry external IDs, URLs and provider-specific metadata.
    if ((issue.workProducts?.length ?? 0) > 0) {
      errors.push(`Task ${issue.slug} has work products that cannot be migrated safely.`);
    }
    // Portability recreates webhook triggers, which are outside migration scope.
    if (issue.recurring && issue.routine?.triggers.some((trigger) => trigger.kind === "webhook")) {
      errors.push(`Task ${issue.slug} has a webhook trigger that cannot be migrated.`);
    }
    if (issue.projectSlug && !projectSlugs.has(issue.projectSlug)) errors.push(`Task ${issue.slug} references missing project ${issue.projectSlug}.`);
    if (issue.projectWorkspaceKey && (!issue.projectSlug || workspaceKeys.get(issue.projectSlug)?.get(issue.projectWorkspaceKey) !== 1)) {
      errors.push(`Task ${issue.slug} references a missing or ambiguous workspace.`);
    }
    if (issue.assigneeAgentSlug && !agentSlugs.has(issue.assigneeAgentSlug)) errors.push(`Task ${issue.slug} references missing agent ${issue.assigneeAgentSlug}.`);
    for (const related of [issue.parentSlug, ...(issue.blockedBy ?? [])]) {
      if (related && !issueSlugs.has(related)) errors.push(`Task ${issue.slug} references missing task ${related}.`);
    }
    const path = new Set<string>();
    let current: string | null = issue.slug;
    while (current && !checkedParents.has(current)) {
      if (path.has(current)) {
        errors.push(`Task ${issue.slug} has a parent cycle.`);
        break;
      }
      path.add(current);
      current = parentByIssue.get(current) ?? null;
    }
    for (const slug of path) checkedParents.add(slug);
  }
  const blockers = new Map((manifest.issues ?? []).map((issue) => [issue.slug, issue.blockedBy ?? []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  for (const slug of blockers.keys()) {
    if (visited.has(slug)) continue;
    const stack: Array<{ slug: string; exit: boolean }> = [{ slug, exit: false }];
    while (stack.length > 0) {
      const entry = stack.pop()!;
      if (entry.exit) {
        visiting.delete(entry.slug);
        visited.add(entry.slug);
        continue;
      }
      if (visiting.has(entry.slug)) {
        errors.push(`Task ${entry.slug} has a blocker cycle.`);
        continue;
      }
      if (visited.has(entry.slug) || !blockers.has(entry.slug)) continue;
      visiting.add(entry.slug);
      stack.push({ slug: entry.slug, exit: true });
      for (const dependency of blockers.get(entry.slug) ?? []) {
        stack.push({ slug: dependency, exit: false });
      }
    }
  }
  const envIdentities = new Set<string>();
  for (const input of manifest.envInputs) {
    // The portability parser deduplicates names case-insensitively per scope.
    const identity = JSON.stringify([input.agentSlug ?? "", input.projectSlug ?? "", input.key.toUpperCase()]);
    if (envIdentities.has(identity)) errors.push("Duplicate environment binding in the same scope.");
    envIdentities.add(identity);
    const label = input.kind === "secret" ? "Secret binding" : "Environment input";
    if (input.agentSlug && input.projectSlug) {
      errors.push(`${label} ${input.key} has ambiguous scope.`);
    }
    if (input.agentSlug && !agentSlugs.has(input.agentSlug)) {
      errors.push(`${label} ${input.key} references missing agent ${input.agentSlug}.`);
    }
    if (input.projectSlug && !projectSlugs.has(input.projectSlug)) {
      errors.push(`${label} ${input.key} references missing project ${input.projectSlug}.`);
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

export const MIGRATION_SKIPPED_MANAGER_ERROR = "An agent would lose its reportsTo link because its manager is skipped.";
export const MIGRATION_SKIPPED_PROJECT_LEAD_ERROR = "A project would lose its lead because its lead agent is skipped.";
export const MIGRATION_SKIPPED_TASK_ASSIGNEE_ERROR = "A task would lose its assignee because its assigned agent is skipped.";
export const MIGRATION_SAFE_PLAN_ERRORS: ReadonlySet<string> = new Set([
  MIGRATION_SKIPPED_MANAGER_ERROR,
  MIGRATION_SKIPPED_PROJECT_LEAD_ERROR,
  MIGRATION_SKIPPED_TASK_ASSIGNEE_ERROR,
]);
