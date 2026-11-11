import type { Agent } from "@myrmidon/shared";

export interface AgentProjectScope {
  id: string;
  leadAgentId: string | null;
  agentIds?: string[];
}

export type AgentScope = { type: "company" } | { type: "project"; projectId: string };

export function parseAgentScope(search: string): AgentScope {
  const value = new URLSearchParams(search).get("scope");
  if (value?.startsWith("project:") && value.length > 8) {
    return { type: "project", projectId: value.slice(8) };
  }
  return { type: "company" };
}

export function agentBelongsToProject(agent: Agent, project: AgentProjectScope): boolean {
  const explicitMembership = (agent as Agent & { projectIds?: string[] }).projectIds;
  if (Array.isArray(explicitMembership)) return explicitMembership.includes(project.id);
  return project.agentIds?.includes(agent.id) === true || project.leadAgentId === agent.id;
}

export function filterAgentsByScope(agents: Agent[], scope: AgentScope, projects: AgentProjectScope[]): Agent[] {
  if (scope.type === "company") return agents;
  const project = projects.find((candidate) => candidate.id === scope.projectId);
  if (!project) return [];
  return agents.filter((agent) => agentBelongsToProject(agent, project));
}
