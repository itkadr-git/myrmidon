import {
  resolveRecoverySlaMinutes,
  type RecoveryFactoryKind,
} from "@myrmidon/shared";

export class RecoveryOwnerUnresolvedError extends Error {
  readonly code: string = "recovery_owner_unresolved";
  readonly kind: string;
  readonly projectId: string | null;

  constructor(
    message: string,
    options?: { kind?: string; projectId?: string | null; cause?: unknown },
  ) {
    super(message);
    this.name = "RecoveryOwnerUnresolvedError";
    this.kind = options?.kind ?? "unknown";
    this.projectId = options?.projectId ?? null;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}

export interface RecoveryOwnerCandidate {
  id?: string;
  agentId?: string;
  userId?: string | null;
  assigneeUserId?: string | null;
  name?: string | null;
  role?: string | null;
  title?: string | null;
  status?: string | null;
  projectId?: string | null;
  projectIds?: readonly string[] | null;
  reportsTo?: string | null;
  casteKey?: string | null;
  capabilities?: string | null;
  isUser?: boolean;
}

export interface ResolveRecoveryOwnerInput {
  kind: RecoveryFactoryKind | string;
  projectId?: string | null;
  candidates: readonly RecoveryOwnerCandidate[];
  now?: Date | string;
  slaOverrides?: Partial<Record<string, number>> | null;
}

export interface ResolveRecoveryOwnerResult {
  owner: { agentId: string };
  slaMinutes: number;
  nextCheckAt: string;
}

interface NormalizedCandidate {
  agentId: string;
  role: string;
  title: string;
  projectId: string | null;
  projectIds: readonly string[];
  reportsTo: string | null;
  isManager: boolean;
  raw: RecoveryOwnerCandidate;
}

function getCandidateAgentId(candidate: RecoveryOwnerCandidate): string | null {
  const id = candidate.id ?? candidate.agentId;
  if (typeof id === "string" && id.trim().length > 0) {
    return id.trim();
  }
  return null;
}

function isUserCandidate(candidate: RecoveryOwnerCandidate): boolean {
  if (candidate.isUser === true) return true;
  if (typeof candidate.userId === "string" && candidate.userId.trim().length > 0) return true;
  if (typeof candidate.assigneeUserId === "string" && candidate.assigneeUserId.trim().length > 0) return true;
  return false;
}

/**
 * Returns numeric priority rank for candidate given the recovery action kind.
 * Lower number = higher priority.
 */
function getRoleRank(kind: string, candidate: NormalizedCandidate): number {
  const role = candidate.role;
  const title = candidate.title;

  switch (kind) {
    case "review_participant_restore":
      // Rule OPE-8312 §4.B.1: lead -> architect -> secondary reviewer (never user-owner)
      if (role === "lead" || title.includes("lead")) return 1;
      if (role === "architect" || title.includes("architect") || title.includes("arch")) return 2;
      if (
        role === "secondary_reviewer" ||
        role === "reviewer" ||
        title.includes("secondary") ||
        title.includes("reviewer")
      ) {
        return 3;
      }
      if (role === "engineer" || title.includes("engineer")) return 4;
      if (role === "qa" || title.includes("qa")) return 5;
      return 6;

    case "ci_restart":
      if (role === "devops" || role === "infra" || role === "sre" || title.includes("devops") || title.includes("infra")) return 1;
      if (role === "engineer" || title.includes("engineer")) return 2;
      if (role === "qa" || title.includes("qa")) return 3;
      if (role === "lead" || title.includes("lead")) return 4;
      if (role === "architect" || title.includes("architect")) return 5;
      return 6;

    case "github_access":
      if (
        role === "devops" ||
        role === "security" ||
        role === "infra" ||
        role === "sre" ||
        title.includes("security") ||
        title.includes("devops")
      ) {
        return 1;
      }
      if (role === "lead" || title.includes("lead")) return 2;
      if (role === "operator" || role === "admin" || title.includes("operator") || title.includes("admin")) return 3;
      if (role === "engineer" || title.includes("engineer")) return 4;
      return 5;

    case "branch_relay":
      if (role === "devops" || role === "infra" || title.includes("devops") || title.includes("relay")) return 1;
      if (role === "engineer" || title.includes("engineer")) return 2;
      if (role === "lead" || title.includes("lead")) return 3;
      return 4;

    case "workspace_myr_ws":
      if (role === "devops" || role === "infra" || role === "sre" || title.includes("workspace") || title.includes("devops")) return 1;
      if (role === "engineer" || title.includes("engineer")) return 2;
      if (role === "lead" || title.includes("lead")) return 3;
      return 4;

    case "devbuild":
      if (role === "devops" || role === "infra" || role === "sre" || title.includes("devbuild") || title.includes("devops")) return 1;
      if (role === "engineer" || title.includes("engineer")) return 2;
      if (role === "lead" || title.includes("lead")) return 3;
      return 4;

    case "disk_space":
      if (role === "devops" || role === "infra" || role === "sre" || title.includes("disk") || title.includes("sre")) return 1;
      if (role === "lead" || title.includes("lead")) return 2;
      if (role === "engineer" || title.includes("engineer")) return 3;
      return 4;

    case "operator_action":
      if (role === "operator" || role === "admin" || title.includes("operator") || title.includes("admin")) return 1;
      if (role === "devops" || role === "sre" || title.includes("devops")) return 2;
      if (role === "lead" || title.includes("lead")) return 3;
      if (role === "cto" || role === "ceo" || title.includes("cto") || title.includes("ceo")) return 4;
      if (role === "engineer" || title.includes("engineer")) return 5;
      return 6;

    default:
      if (role === "devops" || role === "lead" || title.includes("lead") || title.includes("devops")) return 1;
      if (role === "engineer" || title.includes("engineer")) return 2;
      return 3;
  }
}

/**
 * Pure function resolving an addressed technical owner and SLA for a recovery kind and project.
 *
 * Requirements (OPE-8312 §5.7, OPE-8337 P1.7):
 * - Contract R1: produces `{ owner: { agentId }, slaMinutes, nextCheckAt }`
 * - Review escalation: lead -> architect -> secondary reviewer (never user-owner)
 * - Empty pool or unresolvable owner throws `RecoveryOwnerUnresolvedError`
 * - Deterministic outcome: deterministic sorting by project affinity, role rank, manager hierarchy, agentId
 */
export function resolveRecoveryOwner(input: ResolveRecoveryOwnerInput): ResolveRecoveryOwnerResult {
  const kind = typeof input.kind === "string" ? input.kind.trim() : "";
  if (!kind) {
    throw new RecoveryOwnerUnresolvedError("Invalid recovery kind: kind must be a non-empty string", {
      kind: String(input.kind),
      projectId: input.projectId ?? null,
    });
  }

  const rawCandidates = input.candidates;
  if (!rawCandidates || !Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    throw new RecoveryOwnerUnresolvedError(
      `Candidate pool is empty for recovery kind "${kind}" and project "${input.projectId ?? "none"}"`,
      { kind, projectId: input.projectId ?? null },
    );
  }

  const slaMinutes = resolveRecoverySlaMinutes(kind, input.slaOverrides);
  const baseDate = input.now
    ? input.now instanceof Date
      ? input.now
      : new Date(input.now)
    : new Date();
  const nextCheckAt = new Date(baseDate.getTime() + slaMinutes * 60 * 1000).toISOString();

  // Find all manager IDs referenced in reportsTo
  const managerIds = new Set<string>();
  for (const c of rawCandidates) {
    if (typeof c.reportsTo === "string" && c.reportsTo.trim().length > 0) {
      managerIds.add(c.reportsTo.trim());
    }
  }

  const normalized: NormalizedCandidate[] = [];

  for (const candidate of rawCandidates) {
    // Exclude users: assigneeUserId / userId / isUser can never be selected as recovery executor
    if (isUserCandidate(candidate)) {
      continue;
    }

    const agentId = getCandidateAgentId(candidate);
    if (!agentId) {
      continue;
    }

    // Exclude terminated or archived agents
    const status = candidate.status?.trim().toLowerCase();
    if (status === "terminated" || status === "archived") {
      continue;
    }

    // Project matching: if candidate has explicit projectId(s) that conflict with input.projectId, exclude
    if (input.projectId) {
      const candidateProjectId = candidate.projectId?.trim() || null;
      const candidateProjectIds = candidate.projectIds?.map((p) => p.trim()) || [];
      const hasSpecificProject = candidateProjectId !== null || candidateProjectIds.length > 0;
      if (hasSpecificProject) {
        const matchesProject =
          candidateProjectId === input.projectId || candidateProjectIds.includes(input.projectId);
        if (!matchesProject) {
          continue;
        }
      }
    }

    normalized.push({
      agentId,
      role: (candidate.role ?? "").trim().toLowerCase(),
      title: (candidate.title ?? "").trim().toLowerCase(),
      projectId: candidate.projectId?.trim() || null,
      projectIds: candidate.projectIds?.map((p) => p.trim()) || [],
      reportsTo: candidate.reportsTo?.trim() || null,
      isManager: managerIds.has(agentId),
      raw: candidate,
    });
  }

  if (normalized.length === 0) {
    throw new RecoveryOwnerUnresolvedError(
      `No eligible technical agent candidate found for recovery kind "${kind}" and project "${input.projectId ?? "none"}"`,
      { kind, projectId: input.projectId ?? null },
    );
  }

  // Deterministic sort:
  // 1. Role priority rank (lower is better)
  // 2. Exact project match (exact project before unconstrained global)
  // 3. Manager status (managers before non-managers for leadership roles)
  // 4. Stable tie-breaker: agentId lexicographical order
  normalized.sort((a, b) => {
    const rankA = getRoleRank(kind, a);
    const rankB = getRoleRank(kind, b);
    if (rankA !== rankB) {
      return rankA - rankB;
    }

    if (input.projectId) {
      const exactA = a.projectId === input.projectId || a.projectIds.includes(input.projectId);
      const exactB = b.projectId === input.projectId || b.projectIds.includes(input.projectId);
      if (exactA !== exactB) {
        return exactA ? -1 : 1;
      }
    }

    if (a.isManager !== b.isManager) {
      return a.isManager ? -1 : 1;
    }

    return a.agentId.localeCompare(b.agentId);
  });

  const selected = normalized[0]!;

  return {
    owner: { agentId: selected.agentId },
    slaMinutes,
    nextCheckAt,
  };
}
