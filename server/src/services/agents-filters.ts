import type { AgentListItem, AgentListFilters } from "@myrmidon/shared";

export type { AgentListFilters };

export interface NormalizedAgentListFilters {
  q?: string;
  statuses?: string[];
  role?: string;
  reportsTo?: string;
}

export function normalizeAgentListFilters(
  filters?: AgentListFilters | null,
): NormalizedAgentListFilters | null {
  if (!filters) return null;
  const rawQ = typeof filters.q === "string" ? filters.q.trim().toLowerCase() : undefined;
  const q = rawQ && rawQ.length > 0 ? rawQ : undefined;

  let statuses: string[] | undefined;
  if (filters.status) {
    const raw = Array.isArray(filters.status) ? filters.status : [filters.status];
    const parsed = raw
      .flatMap((item) => (typeof item === "string" ? item.split(",") : []))
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
    if (parsed.length > 0) {
      statuses = Array.from(new Set(parsed)).sort();
    }
  }

  const role = typeof filters.role === "string" && filters.role.trim().length > 0
    ? filters.role.trim()
    : undefined;

  const reportsTo = typeof filters.reportsTo === "string" && filters.reportsTo.trim().length > 0
    ? filters.reportsTo.trim()
    : undefined;

  if (!q && !statuses && !role && !reportsTo) {
    return null;
  }
  return {
    ...(q ? { q } : {}),
    ...(statuses ? { statuses } : {}),
    ...(role ? { role } : {}),
    ...(reportsTo ? { reportsTo } : {}),
  };
}

export function filterAgentListItems<T extends {
  name?: string | null;
  role?: string | null;
  title?: string | null;
  status?: string | null;
  reportsTo?: string | null;
}>(
  rows: T[],
  filters?: AgentListFilters | NormalizedAgentListFilters | null,
): T[] {
  if (!filters) return rows;
  const normalized = "statuses" in filters
    ? (filters as NormalizedAgentListFilters)
    : normalizeAgentListFilters(filters as AgentListFilters);
  if (!normalized) return rows;

  const { q, statuses, role, reportsTo } = normalized;

  return rows.filter((agent) => {
    if (q) {
      const needle = q;
      const nameMatch = typeof agent.name === "string" && agent.name.toLowerCase().includes(needle);
      const roleMatch = typeof agent.role === "string" && agent.role.toLowerCase().includes(needle);
      const titleMatch = typeof agent.title === "string" && agent.title.toLowerCase().includes(needle);
      if (!nameMatch && !roleMatch && !titleMatch) {
        return false;
      }
    }

    if (statuses && statuses.length > 0) {
      if (!agent.status || !statuses.includes(agent.status.toLowerCase())) {
        return false;
      }
    }

    if (role !== undefined) {
      if (agent.role !== role) {
        return false;
      }
    }

    if (reportsTo !== undefined) {
      if (reportsTo.toLowerCase() === "none") {
        if (agent.reportsTo !== null && agent.reportsTo !== undefined && agent.reportsTo !== "") {
          return false;
        }
      } else {
        if (agent.reportsTo !== reportsTo) {
          return false;
        }
      }
    }

    return true;
  });
}
