import type { InteractionRecipient, InteractionRouteType } from "./interaction-routing.js";

export type InteractionKind =
  | "decision"
  | "approval"
  | "operator_action"
  | "human_input"
  | string;

export type ProjectInteractionRole = "lead" | "architect" | "secondary_reviewer";

export interface InteractionPrincipal {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
  projectId?: string | null;
  casteKey?: string | null;
}

export type ScopedInteractionPrincipal = InteractionPrincipal & {
  projectRoles?: readonly ProjectInteractionRole[] | null;
  projectId?: string | null;
  casteKey?: string | null;
  isJoinedMember?: boolean;
};

export interface InteractionProjectRoles {
  lead?: ScopedInteractionPrincipal | InteractionRecipient | null;
  architect?: ScopedInteractionPrincipal | InteractionRecipient | null;
  secondary_reviewer?: ScopedInteractionPrincipal | InteractionRecipient | null;
}

export interface InteractionCasteScope {
  projectId?: string | null;
  casteKey?: string | null;
}

export interface ResolveInteractionRecipientInput {
  routeType: InteractionRouteType | "code_review";
  kind: InteractionKind;
  effectiveResolverPolicy?: "human_only" | "anyone" | "not_creator" | string;
  projectId?: string | null;
  casteScope?: InteractionCasteScope | null;
  creator: InteractionRecipient;
  projectRoles?: InteractionProjectRoles | null;
  recipient?: InteractionRecipient | null;
  serviceQueue?: string | null;
}

export interface InteractionEscalationPolicy {
  participantRoles: readonly ProjectInteractionRole[];
  fallbackQueue: string;
  stepDelayMinutes: number;
}

export interface ResolvedInteractionEscalationStep {
  recipient: InteractionRecipient;
  afterMinutes: number;
}

export class InteractionRecipientUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InteractionRecipientUnresolvedError";
  }
}

function principalRecipient(principal: ScopedInteractionPrincipal): InteractionRecipient | null {
  if (principal.type === "agent" && principal.agentId) return { agentId: principal.agentId };
  if (principal.type === "user" && principal.userId) return { userId: principal.userId };
  return null;
}

function sameRecipient(a: InteractionRecipient, b: InteractionRecipient): boolean {
  if ("agentId" in a) return "agentId" in b && a.agentId === b.agentId;
  if ("userId" in a) return "userId" in b && a.userId === b.userId;
  return "serviceQueue" in b && a.serviceQueue === b.serviceQueue;
}

function principalScopeMatches(
  principal: InteractionPrincipal,
  projectId: string | null | undefined,
  casteScope: InteractionCasteScope | null | undefined,
): boolean {
  const effectiveProjectId = projectId ?? casteScope?.projectId;
  if (principal.projectId && principal.projectId !== effectiveProjectId) return false;
  if (principal.casteKey && principal.casteKey !== casteScope?.casteKey) return false;
  return true;
}

function principalProjectMembership(
  principal: ScopedInteractionPrincipal | InteractionRecipient,
  projectId: string,
): boolean {
  return !(("type" in principal) && principal.type === "agent") || principal.isJoinedMember === true;
}

function roleRecipient(
  roles: InteractionProjectRoles | null | undefined,
  projectId: string | null | undefined,
  casteScope: InteractionCasteScope | null | undefined,
  kind: InteractionKind,
  creator: InteractionRecipient,
  effectiveResolverPolicy?: string,
): InteractionRecipient | null {
  for (const role of ["lead", "architect", "secondary_reviewer"] as const) {
    const principal = roles?.[role];
    if (!principal) continue;
    let recipient: InteractionRecipient | null;
    if ("type" in principal) {
      if (principal.type === "agent" && !principalProjectMembership(principal, projectId ?? "")) continue;
      if (!principalScopeMatches(principal, projectId, casteScope)) continue;
      if (principal.projectRoles && !principal.projectRoles.includes(role)) continue;
      recipient = principalRecipient(principal);
    } else {
      recipient = principal;
    }
    if (!recipient || sameRecipient(recipient, creator)) continue;
    if ("type" in principal && principal.type === "agent" && !principalProjectMembership(principal, projectId ?? "")) continue;
    if (effectiveResolverPolicy === "human_only" && !("userId" in recipient)) continue;
    if (kind === "code_review" && "userId" in recipient) continue;
    return recipient;
  }
  return null;
}

export function resolveInteractionRecipient(input: ResolveInteractionRecipientInput): InteractionRecipient {
  let recipient: InteractionRecipient | null = null;

  if (input.routeType === "operator_action") {
    const queue = input.serviceQueue?.trim();
    if (!queue) throw new InteractionRecipientUnresolvedError("operator_action requires a service queue");
    recipient = { serviceQueue: queue };
  } else if (input.routeType === "human_input") {
    recipient = input.recipient && "userId" in input.recipient ? input.recipient : null;
    if (!recipient) throw new InteractionRecipientUnresolvedError("human_input requires a concrete user recipient");
  } else if (input.recipient) {
    recipient = input.recipient;
  } else {
    recipient = roleRecipient(
      input.projectRoles,
      input.projectId,
      input.casteScope,
      input.kind,
      input.creator,
      input.effectiveResolverPolicy,
    );
    if (!recipient) throw new InteractionRecipientUnresolvedError(`${input.routeType} requires a typed human or matching project role`);
  }

  if (input.effectiveResolverPolicy === "human_only" && !("userId" in recipient)) {
    throw new InteractionRecipientUnresolvedError("human_only requires a human user recipient");
  }

  if (sameRecipient(recipient, input.creator)) {
    throw new InteractionRecipientUnresolvedError("The interaction creator cannot be its recipient");
  }
  if (input.kind === "code_review" && "userId" in recipient) {
    throw new InteractionRecipientUnresolvedError("Code review cannot be assigned to a user");
  }
  return recipient;
}

/** Match the router's deterministic role chain, including its terminal queue. */
export function buildInteractionEscalationChain(input: {
  routeType: InteractionRouteType | "code_review";
  policy: InteractionEscalationPolicy;
  projectRoles: Partial<Record<ProjectInteractionRole, ScopedInteractionPrincipal | InteractionRecipient | null>>;
  projectId?: string | null;
  casteScope?: InteractionCasteScope | null;
  creator: InteractionRecipient;
  startAt?: number;
}): ResolvedInteractionEscalationStep[] {
  const seen = new Set<string>();
  const chain: ResolvedInteractionEscalationStep[] = [];
  const recipientKey = (recipient: InteractionRecipient) =>
    "agentId" in recipient ? `agent:${recipient.agentId}` :
      "userId" in recipient ? `user:${recipient.userId}` : `queue:${recipient.serviceQueue}`;

  for (const role of input.policy.participantRoles) {
    const candidate = input.projectRoles[role];
    if (!candidate) continue;
    if ("type" in candidate && candidate.projectRoles && !candidate.projectRoles.includes(role)) continue;
    let recipient: InteractionRecipient;
    if ("type" in candidate) {
      if (candidate.type === "agent" && input.projectId && !principalProjectMembership(candidate, input.projectId)) continue;
      if (!principalScopeMatches(candidate, input.projectId, input.casteScope)) continue;
      const resolved = principalRecipient(candidate);
      if (!resolved) continue;
      recipient = resolved;
    } else {
      recipient = candidate;
    }
    if ((input.routeType === "code_review" && "userId" in recipient) || sameRecipient(recipient, input.creator)) continue;
    if ("serviceQueue" in recipient) continue;
    const key = recipientKey(recipient);
    if (seen.has(key)) continue;
    seen.add(key);
    const startAt = input.startAt ?? 0;
    chain.push({ recipient, afterMinutes: startAt + chain.length * input.policy.stepDelayMinutes });
  }

  const startAt = input.startAt ?? 0;
  chain.push({
    recipient: { serviceQueue: input.policy.fallbackQueue },
    afterMinutes: startAt + chain.length * input.policy.stepDelayMinutes,
  });
  return chain;
}
