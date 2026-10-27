import {
  RECOVERY_SLA_MINUTES_BY_KIND,
  resolveRecoverySlaMinutes,
  type RecoveryFactoryKind,
  type RecoveryFactoryOwner,
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
  serviceQueue?: string | null;
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
  serviceQueue?: string | null;
}

export interface ResolveRecoveryOwnerResult {
  owner: RecoveryFactoryOwner;
  slaMinutes: number;
  nextCheckAt: string;
}

type CandidateOwnerKind = "agentId" | "userId" | "serviceQueue";

interface NormalizedCandidate {
  owner: RecoveryFactoryOwner;
  ownerKind: CandidateOwnerKind;
  role: string;
  casteKey: string;
  title: string;
  projectId: string | null;
  projectIds: readonly string[];
  reportsTo: string | null;
  isManager: boolean;
  raw: RecoveryOwnerCandidate;
}

const INELIGIBLE_STATUSES = new Set([
  "terminated",
  "archived",
  "paused",
  "error",
  "pending_approval",
]);

function isUserCandidate(candidate: RecoveryOwnerCandidate): boolean {
  if (candidate.isUser === true) return true;
  if (typeof candidate.userId === "string" && candidate.userId.trim().length > 0) return true;
  if (typeof candidate.assigneeUserId === "string" && candidate.assigneeUserId.trim().length > 0) return true;
  return false;
}

function resolveCandidateOwner(
  candidate: RecoveryOwnerCandidate,
  isOperatorAction: boolean,
): { owner: RecoveryFactoryOwner; ownerKind: CandidateOwnerKind } | null {
  const serviceQueue = typeof candidate.serviceQueue === "string" && candidate.serviceQueue.trim().length > 0
    ? candidate.serviceQueue.trim()
    : null;
  const userId = [candidate.userId, candidate.assigneeUserId]
    .find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? null;
  const agentId = (candidate.agentId ?? candidate.id)?.trim() || null;
  const hasUser = candidate.isUser === true || userId !== null;
  const identityCount = Number(serviceQueue !== null) + Number(hasUser) + Number(agentId !== null);
  if (identityCount !== 1) return null;

  if (serviceQueue !== null) {
    if (!isOperatorAction) return null;
    return { owner: { serviceQueue }, ownerKind: "serviceQueue" };
  }
  if (hasUser) {
    if (!isOperatorAction || !userId) return null;
    return { owner: { userId }, ownerKind: "userId" };
  }
  if (agentId) return { owner: { agentId }, ownerKind: "agentId" };
  return null;
}

/**
 * Returns numeric priority rank for candidate given the recovery action kind,
 * or null if the candidate role is not eligible for this kind.
 * Lower number = higher priority.
 */
function getRoleRank(kind: string, candidate: NormalizedCandidate): number | null {
  const role = candidate.role;
  const caste = candidate.casteKey;
  const isMatch = (...roles: string[]) =>
    roles.includes(role) || (caste.length > 0 && roles.includes(caste));

  if (candidate.ownerKind === "serviceQueue") {
    return 10;
  }

  if (candidate.ownerKind === "userId") {
    if (kind === "operator_action") {
      if (isMatch("operator", "admin")) return 2;
      return 5;
    }
    return null;
  }

  // Agent candidates
  switch (kind) {
    case "review_participant_restore":
      // Rule OPE-8312 §4.B.1: lead -> architect -> secondary reviewer (never user-owner)
      if (isMatch("lead")) return 1;
      if (isMatch("architect")) return 2;
      if (isMatch("secondary_reviewer", "reviewer")) return 3;
      if (isMatch("engineer")) return 4;
      return null;

    case "ci_restart":
      if (isMatch("devops", "infra", "sre")) return 1;
      if (isMatch("engineer")) return 2;
      if (isMatch("qa")) return 3;
      if (isMatch("lead")) return 4;
      if (isMatch("architect")) return 5;
      return null;

    case "github_access":
      if (isMatch("devops", "security", "infra", "sre")) return 1;
      if (isMatch("lead")) return 2;
      if (isMatch("operator", "admin")) return 3;
      if (isMatch("engineer")) return 4;
      return null;

    case "branch_relay":
      if (isMatch("devops", "infra", "sre")) return 1;
      if (isMatch("engineer")) return 2;
      if (isMatch("lead")) return 3;
      return null;

    case "workspace_myr_ws":
      if (isMatch("devops", "infra", "sre")) return 1;
      if (isMatch("engineer")) return 2;
      if (isMatch("lead")) return 3;
      return null;

    case "devbuild":
      if (isMatch("devops", "infra", "sre")) return 1;
      if (isMatch("engineer")) return 2;
      if (isMatch("lead")) return 3;
      return null;

    case "disk_space":
      if (isMatch("devops", "infra", "sre")) return 1;
      if (isMatch("lead")) return 2;
      if (isMatch("engineer")) return 3;
      return null;

    case "operator_action":
      if (isMatch("operator", "admin")) return 1;
      if (isMatch("devops", "sre", "infra")) return 3;
      if (isMatch("lead", "cto", "ceo")) return 4;
      if (isMatch("engineer")) return 5;
      return 6;

    default:
      // Legacy infrastructure/watchdog kinds
      if (isMatch("devops", "infra", "sre", "lead")) return 1;
      if (isMatch("engineer", "qa", "architect")) return 2;
      return null;
  }
}

/**
 * Pure function resolving an addressed technical owner and SLA for a recovery kind and project.
 *
 * Requirements (OPE-8312 §5.7, OPE-8337 P1.7, OPE-9138):
 * - Contract R1: produces `{ owner, slaMinutes, nextCheckAt }`
 * - Review escalation: lead -> architect -> secondary reviewer (never user-owner)
 * - Empty pool or unresolvable owner throws `RecoveryOwnerUnresolvedError`
 * - Deterministic outcome: deterministic sorting by project affinity, role rank, manager hierarchy, owner key
 */
export function resolveRecoveryOwner(input: ResolveRecoveryOwnerInput): ResolveRecoveryOwnerResult {
  const kind = typeof input.kind === "string" ? input.kind.trim() : "";
  if (!kind || !(kind in RECOVERY_SLA_MINUTES_BY_KIND)) {
    throw new RecoveryOwnerUnresolvedError(
      !kind ? "Invalid recovery kind: kind must be a non-empty string" : `Unknown recovery kind: "${kind}"`,
      {
        kind: String(input.kind),
        projectId: input.projectId ?? null,
      },
    );
  }

  if (kind === "operator_action" && input.serviceQueue !== undefined && input.serviceQueue !== null) {
    const queue = input.serviceQueue.trim();
    if (!/^[a-z0-9][a-z0-9_.:-]*$/i.test(queue)) {
      throw new RecoveryOwnerUnresolvedError("Invalid operator_action serviceQueue", { kind, projectId: input.projectId ?? null });
    }
  }

  const rawCandidates = input.candidates;
  if (!rawCandidates || !Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    if (
      kind === "operator_action" &&
      typeof input.serviceQueue === "string" &&
      /^[a-z0-9][a-z0-9_.:-]*$/i.test(input.serviceQueue.trim())
    ) {
      const slaMinutes = resolveRecoverySlaMinutes(kind, input.slaOverrides);
      const baseDate = input.now
        ? input.now instanceof Date
          ? input.now
          : new Date(input.now)
        : new Date();
      if (Number.isNaN(baseDate.getTime())) {
        throw new RecoveryOwnerUnresolvedError(
          "Invalid now parameter: must be a valid Date or ISO timestamp string",
          { kind, projectId: input.projectId ?? null },
        );
      }
      return {
        owner: { serviceQueue: input.serviceQueue.trim() },
        slaMinutes,
        nextCheckAt: new Date(baseDate.getTime() + slaMinutes * 60 * 1000).toISOString(),
      };
    }

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
  if (Number.isNaN(baseDate.getTime())) {
    throw new RecoveryOwnerUnresolvedError(
      "Invalid now parameter: must be a valid Date or ISO timestamp string",
      { kind, projectId: input.projectId ?? null },
    );
  }
  const nextCheckAt = new Date(baseDate.getTime() + slaMinutes * 60 * 1000).toISOString();

  const isOperatorAction = kind === "operator_action";

  // Find all manager IDs referenced in reportsTo
  const managerIds = new Set<string>();
  for (const c of rawCandidates) {
    if (typeof c.reportsTo === "string" && c.reportsTo.trim().length > 0) {
      managerIds.add(c.reportsTo.trim());
    }
  }

  const normalized: NormalizedCandidate[] = [];

  for (const candidate of rawCandidates) {
    // Status filtering: exclude terminated, archived, paused, error, pending_approval
    const status = candidate.status?.trim().toLowerCase();
    if (status && INELIGIBLE_STATUSES.has(status)) {
      continue;
    }

    const resolved = resolveCandidateOwner(candidate, isOperatorAction);
    if (!resolved) {
      continue;
    }

    // Project matching: if candidate has explicit projectId(s) that conflict with input.projectId, exclude
    if (input.projectId) {
      const candidateProjectId = typeof candidate.projectId === "string" && candidate.projectId.trim().length > 0
        ? candidate.projectId.trim()
        : null;
      const candidateProjectIds = Array.isArray(candidate.projectIds)
        ? candidate.projectIds.map((p: string) => String(p).trim()).filter((p: string) => p.length > 0)
        : [];
      const hasSpecificProject = candidateProjectId !== null || candidateProjectIds.length > 0;
      if (hasSpecificProject) {
        const matchesProject =
          (candidateProjectId !== null && candidateProjectId === input.projectId) ||
          candidateProjectIds.includes(input.projectId);
        if (!matchesProject) {
          continue;
        }
      }
    }

    const norm: NormalizedCandidate = {
      owner: resolved.owner,
      ownerKind: resolved.ownerKind,
      role: (candidate.role ?? "").trim().toLowerCase(),
      casteKey: (candidate.casteKey ?? "").trim().toLowerCase(),
      title: (candidate.title ?? "").trim().toLowerCase(),
      projectId: candidate.projectId?.trim() || null,
      projectIds: Array.isArray(candidate.projectIds)
        ? candidate.projectIds.map((p: string) => String(p).trim()).filter((p: string) => p.length > 0)
        : [],
      reportsTo: candidate.reportsTo?.trim() || null,
      isManager: resolved.ownerKind === "agentId" && "agentId" in resolved.owner
        ? managerIds.has(resolved.owner.agentId)
        : false,
      raw: candidate,
    };

    const rank = getRoleRank(kind, norm);
    if (rank === null) {
      // Role is not allowed for this kind (e.g. marketer on ci_restart)
      continue;
    }

    normalized.push(norm);
  }

  if (normalized.length === 0) {
    // For operator_action, check if fallback serviceQueue is provided
    if (
      isOperatorAction &&
      typeof input.serviceQueue === "string" &&
      /^[a-z0-9][a-z0-9_.:-]*$/i.test(input.serviceQueue.trim())
    ) {
      return {
        owner: { serviceQueue: input.serviceQueue.trim() },
        slaMinutes,
        nextCheckAt,
      };
    }

    throw new RecoveryOwnerUnresolvedError(
      `No eligible technical agent candidate found for recovery kind "${kind}" and project "${input.projectId ?? "none"}"`,
      { kind, projectId: input.projectId ?? null },
    );
  }

  // Deterministic sort:
  // 1. Role priority rank (lower is better)
  // 2. Exact project match (exact project before unconstrained global)
  // 3. Manager status (managers before non-managers for leadership roles)
  // 4. Stable tie-breaker: owner key lexicographical order
  normalized.sort((a, b) => {
    const rankA = getRoleRank(kind, a)!;
    const rankB = getRoleRank(kind, b)!;
    if (rankA !== rankB) {
      return rankA - rankB;
    }

    if (input.projectId) {
      const exactA = (a.projectId !== null && a.projectId === input.projectId) || a.projectIds.includes(input.projectId);
      const exactB = (b.projectId !== null && b.projectId === input.projectId) || b.projectIds.includes(input.projectId);
      if (exactA !== exactB) {
        return exactA ? -1 : 1;
      }
    }

    if (a.isManager !== b.isManager) {
      return a.isManager ? -1 : 1;
    }

    const keyA = "agentId" in a.owner ? a.owner.agentId : "userId" in a.owner ? a.owner.userId : a.owner.serviceQueue;
    const keyB = "agentId" in b.owner ? b.owner.agentId : "userId" in b.owner ? b.owner.userId : b.owner.serviceQueue;
    return keyA.localeCompare(keyB);
  });

  const selected = normalized[0]!;

  return {
    owner: selected.owner,
    slaMinutes,
    nextCheckAt,
  };
}
