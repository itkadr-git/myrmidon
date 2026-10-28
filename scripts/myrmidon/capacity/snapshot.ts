export interface StructuralIssueSnapshot {
  id: string;
  identifier: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
  priority: "critical" | "high" | "medium" | "low";
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
  "raw",
]);

export const VALID_STATUSES = new Set([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
]);

export const VALID_PRIORITIES = new Set([
  "critical",
  "high",
  "medium",
  "low",
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_REGEX = /^[A-Z0-9]+-\d+$/;

function isValidUuid(val: unknown): val is string {
  return typeof val === "string" && UUID_REGEX.test(val);
}

function isValidIsoDate(val: unknown): val is string {
  if (typeof val !== "string") return false;
  const d = new Date(val);
  return !isNaN(d.getTime());
}

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

  if (!isValidIsoDate(obj.capturedAt)) {
    throw new Error(`Invalid capturedAt timestamp: ${String(obj.capturedAt)}`);
  }

  if (!obj.scope || typeof obj.scope !== "object") {
    throw new Error("Missing or invalid scope object");
  }
  const scope = obj.scope as Record<string, unknown>;
  if (typeof scope.release !== "string" || !scope.release.trim()) {
    throw new Error("Invalid scope.release");
  }
  if (!isValidUuid(scope.companyId)) {
    throw new Error(`Invalid scope.companyId UUID: ${String(scope.companyId)}`);
  }

  if (!obj.metrics || typeof obj.metrics !== "object") {
    throw new Error("Missing or invalid metrics object");
  }
  const metrics = obj.metrics as Record<string, unknown>;
  if (typeof metrics.totalOpenIssues !== "number" || metrics.totalOpenIssues < 0) {
    throw new Error("Invalid metrics.totalOpenIssues");
  }
  if (typeof metrics.readyIssuesCount !== "number" || metrics.readyIssuesCount < 0) {
    throw new Error("Invalid metrics.readyIssuesCount");
  }

  if (!Array.isArray(obj.issues) || !Array.isArray(obj.issueRelations)) {
    throw new Error("Snapshot must contain issues and issueRelations arrays");
  }

  if (metrics.totalOpenIssues !== obj.issues.length) {
    throw new Error(
      `metrics.totalOpenIssues (${metrics.totalOpenIssues}) does not match issues count (${obj.issues.length})`,
    );
  }

  const issueIds = new Set<string>();

  for (const issue of obj.issues) {
    if (!issue || typeof issue !== "object") {
      throw new Error("Invalid issue in snapshot");
    }
    for (const key of Object.keys(issue)) {
      if (FORBIDDEN_CONTENT_KEYS.has(key.toLowerCase())) {
        throw new Error(`Forbidden key "${key}" found in issue snapshot`);
      }
    }
    const item = issue as Record<string, unknown>;

    if (!isValidUuid(item.id)) {
      throw new Error(`Invalid issue id UUID: ${String(item.id)}`);
    }
    issueIds.add(item.id as string);

    if (typeof item.identifier !== "string" || !IDENTIFIER_REGEX.test(item.identifier)) {
      throw new Error(`Invalid issue identifier: ${String(item.identifier)}`);
    }

    if (!isValidUuid(item.companyId)) {
      throw new Error(`Invalid issue companyId: ${String(item.companyId)}`);
    }

    if (item.projectId !== null && !isValidUuid(item.projectId)) {
      throw new Error(`Invalid issue projectId: ${String(item.projectId)}`);
    }

    if (item.parentId !== null && !isValidUuid(item.parentId)) {
      throw new Error(`Invalid issue parentId: ${String(item.parentId)}`);
    }

    if (typeof item.status !== "string" || !VALID_STATUSES.has(item.status)) {
      throw new Error(`Invalid issue status: ${String(item.status)}`);
    }

    if (typeof item.priority !== "string" || !VALID_PRIORITIES.has(item.priority)) {
      throw new Error(`Invalid issue priority: ${String(item.priority)}`);
    }

    if (item.casteKey !== null && typeof item.casteKey !== "string") {
      throw new Error(`Invalid issue casteKey: ${String(item.casteKey)}`);
    }

    if (
      typeof item.pheromoneStrength !== "number" ||
      !Number.isInteger(item.pheromoneStrength) ||
      item.pheromoneStrength < 0
    ) {
      throw new Error(`Invalid issue pheromoneStrength: ${String(item.pheromoneStrength)}`);
    }

    if (item.assigneeAgentId !== null && !isValidUuid(item.assigneeAgentId)) {
      throw new Error(`Invalid issue assigneeAgentId: ${String(item.assigneeAgentId)}`);
    }

    if (item.assigneeUserId !== null && typeof item.assigneeUserId !== "string") {
      throw new Error(`Invalid issue assigneeUserId: ${String(item.assigneeUserId)}`);
    }

    if (item.executionLockedAt !== null && !isValidIsoDate(item.executionLockedAt)) {
      throw new Error(`Invalid issue executionLockedAt: ${String(item.executionLockedAt)}`);
    }

    if (!isValidIsoDate(item.createdAt)) {
      throw new Error(`Invalid issue createdAt: ${String(item.createdAt)}`);
    }

    if (!isValidIsoDate(item.updatedAt)) {
      throw new Error(`Invalid issue updatedAt: ${String(item.updatedAt)}`);
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
    const item = rel as Record<string, unknown>;

    if (!isValidUuid(item.id)) {
      throw new Error(`Invalid relation id: ${String(item.id)}`);
    }
    if (!isValidUuid(item.companyId)) {
      throw new Error(`Invalid relation companyId: ${String(item.companyId)}`);
    }
    if (!isValidUuid(item.issueId)) {
      throw new Error(`Invalid relation issueId: ${String(item.issueId)}`);
    }
    if (!isValidUuid(item.relatedIssueId)) {
      throw new Error(`Invalid relation relatedIssueId: ${String(item.relatedIssueId)}`);
    }
    if (item.type !== "blocks") {
      throw new Error(`Invalid relation type (expected "blocks"): ${String(item.type)}`);
    }
    if (!isValidIsoDate(item.createdAt)) {
      throw new Error(`Invalid relation createdAt: ${String(item.createdAt)}`);
    }
  }

  const typedSnapshot = data as CapacityPolicySnapshot;
  const actualReadyCount = calculateReadyIssuesCount(typedSnapshot.issues, typedSnapshot.issueRelations);
  if (metrics.readyIssuesCount !== actualReadyCount) {
    throw new Error(
      `metrics.readyIssuesCount (${metrics.readyIssuesCount}) does not match calculated ready count (${actualReadyCount})`,
    );
  }

  return typedSnapshot;
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

import * as fs from "node:fs/promises";
import * as path from "node:path";

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
