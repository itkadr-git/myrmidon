export interface StructuralIssueSnapshot {
  id: string;
  identifier: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  status: string;
  priority: string;
  casteKey: string | null;
  pheromoneStrength: number;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionLockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StructuralIssueRelationSnapshot {
  id: string;
  companyId: string;
  issueId: string;
  relatedIssueId: string;
  type: "blocks";
  createdAt: string;
}

export interface CapacityPolicySnapshot {
  version: 1;
  capturedAt: string;
  scope: {
    release: string;
    companyId: string;
  };
  metrics: {
    totalOpenIssues: number;
    readyIssuesCount: number;
  };
  issues: StructuralIssueSnapshot[];
  issueRelations: StructuralIssueRelationSnapshot[];
}

export const FORBIDDEN_CONTENT_KEYS = new Set([
  "title",
  "description",
  "body",
  "text",
  "comment",
  "comments",
  "notes",
  "summary",
  "secret",
  "password",
  "token",
]);

export function isIssueReadyForClaim(
  issue: StructuralIssueSnapshot,
  relationsByIssueId: Map<string, StructuralIssueRelationSnapshot[]>,
  issuesById: Map<string, StructuralIssueSnapshot>,
): boolean {
  if (issue.status !== "todo") return false;
  if (issue.assigneeAgentId !== null || issue.assigneeUserId !== null) return false;
  if (issue.executionLockedAt !== null) return false;
  if (!issue.projectId && !issue.casteKey) return false;

  const blockers = relationsByIssueId.get(issue.id) ?? [];
  for (const rel of blockers) {
    if (rel.type !== "blocks") continue;
    const blocker = issuesById.get(rel.relatedIssueId);
    if (blocker && blocker.status !== "done" && blocker.status !== "cancelled") {
      return false;
    }
  }

  return true;
}

export function calculateReadyIssuesCount(
  issues: StructuralIssueSnapshot[],
  relations: StructuralIssueRelationSnapshot[],
): number {
  const issuesById = new Map<string, StructuralIssueSnapshot>();
  for (const issue of issues) {
    issuesById.set(issue.id, issue);
  }

  const relationsByIssueId = new Map<string, StructuralIssueRelationSnapshot[]>();
  for (const rel of relations) {
    const list = relationsByIssueId.get(rel.issueId) ?? [];
    list.push(rel);
    relationsByIssueId.set(rel.issueId, list);
  }

  let count = 0;
  for (const issue of issues) {
    if (isIssueReadyForClaim(issue, relationsByIssueId, issuesById)) {
      count++;
    }
  }
  return count;
}

export function validateSnapshot(data: unknown): CapacityPolicySnapshot {
  if (!data || typeof data !== "object") {
    throw new Error("Snapshot must be an object");
  }

  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`Invalid snapshot version: ${String(obj.version)}`);
  }

  if (!Array.isArray(obj.issues) || !Array.isArray(obj.issueRelations)) {
    throw new Error("Snapshot must contain issues and issueRelations arrays");
  }

  for (const issue of obj.issues) {
    if (!issue || typeof issue !== "object") {
      throw new Error("Invalid issue in snapshot");
    }
    for (const key of Object.keys(issue)) {
      if (FORBIDDEN_CONTENT_KEYS.has(key.toLowerCase())) {
        throw new Error(`Forbidden key "${key}" found in issue snapshot`);
      }
    }
    const typed = issue as Partial<StructuralIssueSnapshot>;
    if (!typed.id || !typed.identifier || !typed.companyId || !typed.status || !typed.priority) {
      throw new Error(`Missing required structural fields in issue: ${String(typed.id)}`);
    }
  }

  for (const rel of obj.issueRelations) {
    if (!rel || typeof rel !== "object") {
      throw new Error("Invalid issueRelation in snapshot");
    }
    for (const key of Object.keys(rel)) {
      if (FORBIDDEN_CONTENT_KEYS.has(key.toLowerCase())) {
        throw new Error(`Forbidden key "${key}" found in relation snapshot`);
      }
    }
    const typed = rel as Partial<StructuralIssueRelationSnapshot>;
    if (!typed.id || !typed.companyId || !typed.issueId || !typed.relatedIssueId || typed.type !== "blocks") {
      throw new Error(`Invalid structural issueRelation: ${String(typed.id)}`);
    }
  }

  return data as CapacityPolicySnapshot;
}

export function serializeDeterministicSnapshot(snapshot: CapacityPolicySnapshot): string {
  const sortedIssues = [...snapshot.issues].sort((a, b) => {
    const numA = parseInt(a.identifier.replace(/\D/g, ""), 10) || 0;
    const numB = parseInt(b.identifier.replace(/\D/g, ""), 10) || 0;
    if (numA !== numB) return numA - numB;
    return a.id.localeCompare(b.id);
  });

  const sortedRelations = [...snapshot.issueRelations].sort((a, b) => {
    if (a.issueId !== b.issueId) return a.issueId.localeCompare(b.issueId);
    if (a.relatedIssueId !== b.relatedIssueId) return a.relatedIssueId.localeCompare(b.relatedIssueId);
    return a.id.localeCompare(b.id);
  });

  const normalized: CapacityPolicySnapshot = {
    version: 1,
    capturedAt: snapshot.capturedAt,
    scope: {
      release: snapshot.scope.release,
      companyId: snapshot.scope.companyId,
    },
    metrics: {
      totalOpenIssues: sortedIssues.length,
      readyIssuesCount: calculateReadyIssuesCount(sortedIssues, sortedRelations),
    },
    issues: sortedIssues.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      companyId: issue.companyId,
      projectId: issue.projectId,
      parentId: issue.parentId,
      status: issue.status,
      priority: issue.priority,
      casteKey: issue.casteKey,
      pheromoneStrength: issue.pheromoneStrength,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      executionLockedAt: issue.executionLockedAt,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    })),
    issueRelations: sortedRelations.map((rel) => ({
      id: rel.id,
      companyId: rel.companyId,
      issueId: rel.issueId,
      relatedIssueId: rel.relatedIssueId,
      type: rel.type,
      createdAt: rel.createdAt,
    })),
  };

  return JSON.stringify(normalized, null, 2) + "\n";
}
