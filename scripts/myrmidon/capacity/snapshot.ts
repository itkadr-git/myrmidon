import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";

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
  "summary",
  "notes",
  "password",
  "secret",
  "token",
  "raw",
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
    const blockingIssue = issuesById.get(rel.relatedIssueId);
    if (blockingIssue && blockingIssue.status !== "done" && blockingIssue.status !== "cancelled") {
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

  let readyCount = 0;
  for (const issue of issues) {
    if (isIssueReadyForClaim(issue, relationsByIssueId, issuesById)) {
      readyCount++;
    }
  }
  return readyCount;
}

export function validateSnapshot(data: unknown): CapacityPolicySnapshot {
  if (!data || typeof data !== "object") {
    throw new Error("Snapshot must be an object");
  }
  const obj = data as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`Unsupported snapshot version: ${String(obj.version)}`);
  }
  if (!obj.scope || typeof obj.scope !== "object") {
    throw new Error("Snapshot missing scope");
  }
  if (!Array.isArray(obj.issues) || !Array.isArray(obj.issueRelations)) {
    throw new Error("Snapshot must contain issues and issueRelations arrays");
  }

  for (const issue of obj.issues) {
    if (!issue || typeof issue !== "object") {
      throw new Error("Invalid issue entry in snapshot");
    }
    const issueObj = issue as Record<string, unknown>;
    for (const key of Object.keys(issueObj)) {
      if (FORBIDDEN_CONTENT_KEYS.has(key.toLowerCase())) {
        throw new Error(`Forbidden field "${key}" detected in issue snapshot`);
      }
    }
    if (!issueObj.id || !issueObj.identifier || !issueObj.companyId || !issueObj.status || !issueObj.priority) {
      throw new Error(`Missing required structural field on issue ${String(issueObj.id ?? "unknown")}`);
    }
  }

  for (const rel of obj.issueRelations) {
    if (!rel || typeof rel !== "object") {
      throw new Error("Invalid issueRelation entry in snapshot");
    }
    const relObj = rel as Record<string, unknown>;
    for (const key of Object.keys(relObj)) {
      if (FORBIDDEN_CONTENT_KEYS.has(key.toLowerCase())) {
        throw new Error(`Forbidden field "${key}" detected in issueRelation snapshot`);
      }
    }
    if (!relObj.id || !relObj.issueId || !relObj.relatedIssueId || relObj.type !== "blocks") {
      throw new Error(`Invalid structural issueRelation ${String(relObj.id ?? "unknown")}`);
    }
  }

  return data as CapacityPolicySnapshot;
}

export function serializeDeterministicSnapshot(snapshot: CapacityPolicySnapshot): string {
  const validated = validateSnapshot(snapshot);

  const sortedIssues = [...validated.issues].sort((a, b) => {
    const numA = parseInt(a.identifier.replace(/\D/g, ""), 10) || 0;
    const numB = parseInt(b.identifier.replace(/\D/g, ""), 10) || 0;
    if (numA !== numB) return numA - numB;
    return a.id.localeCompare(b.id);
  });

  const sortedRelations = [...validated.issueRelations].sort((a, b) => {
    if (a.issueId !== b.issueId) return a.issueId.localeCompare(b.issueId);
    if (a.relatedIssueId !== b.relatedIssueId) return a.relatedIssueId.localeCompare(b.relatedIssueId);
    return a.id.localeCompare(b.id);
  });

  const normalized: CapacityPolicySnapshot = {
    version: 1,
    capturedAt: validated.capturedAt,
    scope: {
      release: validated.scope.release,
      companyId: validated.scope.companyId,
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
      pheromoneStrength: issue.pheromoneStrength ?? 0,
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

export async function exportStructuralSnapshotFromFile(
  inputPath: string,
  outputPath?: string,
): Promise<CapacityPolicySnapshot> {
  const raw = await fs.readFile(inputPath, "utf-8");
  const parsed = JSON.parse(raw);
  const validated = validateSnapshot(parsed);
  const serialized = serializeDeterministicSnapshot(validated);

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, serialized, "utf-8");
  }

  return JSON.parse(serialized) as CapacityPolicySnapshot;
}
